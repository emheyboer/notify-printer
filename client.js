#!/usr/bin/env node
const fs = require('fs');
const spawn = require('child_process').spawn;
const {JSDOM} = require("jsdom");
const ReceiptPrinterEncoder = require('@point-of-sale/receipt-printer-encoder');
const { createCanvas, loadImage } = require('canvas');
const config = require('./config.json');

const api_url = 'https://api.pushover.net/1';
const websocket_url = 'wss://client.pushover.net/push';

const Frame = {
    KeepAlive: '#',
    NewMessage: '!',
    Reload: 'R',
    PermanentError: 'E',
    OtherSessionLoggedIn: 'A', 
}

function check(response) {
    if (response.status == 1) {
        return;
    }
    response.errors && response.errors.forEach(error => {
        console.error(`error (status = ${response.status}):`, error);
    });
    process.exit(response.status);
}

function retryFetch(resource, options, backoff = 500) {
    function wait(delay){
        return new Promise((resolve) => setTimeout(resolve, delay));
    }
    function onError(_err){
        return wait(backoff).then(() => retryFetch(resource, options, backoff * 2));
    }
    return fetch(resource, options).catch(onError);
}

async function login(config) {
    console.log('logging in...');

    const parameters = {
        email: config.pushover.email,
        password: config.pushover.password,
    };

    const json = await retryFetch(api_url + '/users/login.json', {
        method: 'post',
        headers: {
            'User-Agent': config.user_agent,
        },
        body: new URLSearchParams(parameters),
    }).then(res => res.json());
    check(json);

    return json.secret;
}

async function register(config) {
    console.log('registering device...');

    const parameters = {
        secret: config.pushover.secret,
        name: config.pushover.name,
        os: 'O',
    };

    const json = await retryFetch(api_url + '/devices.json', {
        method: 'post',
        headers: {
            'User-Agent': config.user_agent,
        },
        body: new URLSearchParams(parameters),
    }).then(res => res.json());
    check(json);

    return json.id;
}

async function getMessages(config) {
    const parameters = {
        secret: config.pushover.secret,
        device_id: config.pushover.id,
    };

    const json = await retryFetch(api_url + '/messages.json?' + new URLSearchParams(parameters), {
        method: 'get',
        headers: {
            'User-Agent': config.user_agent,
        },
    }).then(res => res.json());
    check(json);

    return json.messages;
}

async function deleteMessages(config, messages) {
    if (!messages.length) return;

    const message_ids = messages.map(message => BigInt(message.id_str));
    const highest_message = message_ids.reduce((max, n) => n > max ? n : max);

    const parameters = {
        secret: config.pushover.secret,
        message: highest_message,
    };

    const json = await retryFetch(api_url + `/devices/${config.pushover.id}/update_highest_message.json`, {
        method: 'post',
        headers: {
            'User-Agent': config.user_agent,
        },
        body: new URLSearchParams(parameters),
    }).then(res => res.json());
    check(json);
}

function listenForMessages(config) {
    console.log('listening for messages...');

    let reconnect = true;

    let last_keep_alive = new Date();
    let health_check_timeout;
    function health_check() {
        const delay = 60*1000;
        if (new Date() - last_keep_alive > delay) {
            console.log('disconnecting (reason = expired keep-alive)...');
            socket.close();
        } else {
            health_check_timeout = setTimeout(health_check, delay);
        }
    }
    health_check();

    const socket = new WebSocket(websocket_url);

    socket.addEventListener('open', event => {
        socket.send(`login:${config.pushover.id}:${config.pushover.secret}\n`);
    });

    socket.addEventListener('message', async event => {
        const frame_type = await event.data.text();

        switch (frame_type) {
            case Frame.KeepAlive:
                last_keep_alive = new Date();
                break;
            case Frame.NewMessage:
                onNewMessage(config);
                break;
            case Frame.Reload:
                console.log('disconnecting (reason = reload request)...');
                socket.close();
                break;
            case Frame.PermanentError:
                console.log('disconnecting (reason = permanent error)...');
                reconnect = false;
                socket.close();
                break;
            case Frame.OtherSessionLoggedIn:
                console.log('disconnecting (reason = other session logged in)...');
                reconnect = false;
                socket.close();
                break;
        }
    });

    socket.addEventListener('close', event => {
        clearTimeout(health_check_timeout);

        if (reconnect) {
            const delay = 5;
            console.log(`reconnecting in ${delay}s...`);
            setTimeout(() => listenForMessages(config), delay * 1000);
        } else {
            const message = 'printer disconnected\nplease resolve errors before reconnecting';
            console.log(message);
            sendToPrinter(config, message);
        }
    });

    socket.addEventListener('error', error => {
        console.error(`disconnecting (reason = ${error.message || 'connection error'})...`);
        socket.close();
    });
}

async function clearMessageQueue(config) {
    console.log('clearing message queue...');
    const messages = await getMessages(config);
    await deleteMessages(config, messages);
}

async function onNewMessage(config) {
    const messages = await getMessages(config);
    await deleteMessages(config, messages);

    for (let message of messages) {
        if (!isNaN(config.min_priority) && message.priority < config.min_priority) return;

        const {text, encoder} = await formatMessage(config, message);
        console.log();
        console.log(JSON.stringify(text));
        sendToPrinter(config, encoder);
    }
}

function sendToPrinter(config, data) {
    if (typeof data == 'string') {
        data = new ReceiptPrinterEncoder(config.printer)
            .initialize()
            .codepage('auto')
            .line(data);
    }

    const child = spawn('lp', ['-d', config.printer.name, '-o', 'raw']);
    child.stdin.write(' '.repeat(80) + '\n');
    child.stdin.write(data.cut().encode());
    child.stdin.end();
}

async function formatMessage(config, message) {
    const title = message.title ?? message.app;
    let text = title;
    const encoder = new ReceiptPrinterEncoder(config.printer)
        .initialize()
        .codepage('auto')
        .bold(true)
        .line(title)
        .rule()
        .bold(false);

    let body = message.message;
    if (message.html == 1) {
        const {document} = new JSDOM(message.message).window;
        text += '\n' + document.body.textContent ?? body;
        await formatHTML(config, encoder, document);
        encoder.newline();
    } else {
        // remove leading and trailing whitespace
        body = body.trim().split('\n').map(line => line.trim()).join('\n');

        // collapse whitespace
        body = body.replaceAll('\t', ' ').replaceAll(/ {2,}/g, ' ');

        text += '\n' + body;
        encoder.line(body);
    }

    if (message.url) {
        encoder.qrcode(message.url, config.qr_code);
        if (message.url_title) {
            text += '\n' + message.url_title;
            encoder.line(message.url_title);
        } else {
            encoder.line(message.url);
        }
        text += '\n' + message.url;
    }

    return {text, encoder};
}

async function formatHTML(config, encoder, element) {
    let after;
    switch (element.nodeName) {
        case 'STRONG':
        case 'B':
            encoder.bold(true);
            after = encoder => encoder.bold(false);
            break;
        case 'EM':
        case 'I': // italics aren't supported by most printers
            encoder.italic(true);
            after = encoder => encoder.italic(false);
            break;
        case 'U':
            encoder.underline(true);
            after = encoder => encoder.underline(false);
            break;
        case 'FONT': // instead of attempting to apply a font color, we just switch to white-on-black
            if (element.color && element.color != '#000000') {
                encoder.invert(true);
                after = encoder => encoder.invert(false);
            }  
            break;
        case 'MARK':
            encoder.invert(true);
            after = encoder => encoder.invert(false);
            break;
        case 'A':
            encoder.qrcode(element.href, config.qr_code);
            break;
        case 'HR':
            encoder.rule();
            break;
        case 'BR':
            encoder.newline();
            break;
        case 'LI':
            encoder.text(' - ');
            break;
        case 'CENTER':
            encoder.align('center');
            after = encoder => encoder.align('left');
            break;
        case 'H1':
            encoder.size(4,4);
            after = encoder => encoder.size(1, 1);
            break;
        case 'H2':
            encoder.size(3,3);
            after = encoder => encoder.size(1, 1);
            break;
        case 'H3':
        case 'BIG':
            encoder.size(2,2);
            after = encoder => encoder.size(1, 1);
            break;
        case 'Q':
            encoder.text('"');
            after = encoder => encoder.text('"');
            break;
        case 'BLOCKQUOTE':
            encoder.align('center').text('"');
            after = encoder => encoder.text('"').align('left');
            break;
        case 'IMG':
            if (!element.src) break;
            try {
                const image = await loadImage(element.src);
                encoder.image(image, ...resize(image.width, image.height), 'atkinson');
            } catch {
                encoder.qrcode(element.src, config.qr_code);
            }
            break;
        case 'VIDEO':
        case 'AUDIO':
        case 'EMBED':
            encoder.qrcode(element.src, config.qr_code);
            break;
        case 'OBJECT':
            encoder.qrcode(element.data, config.qr_code);
            break;
        case '#text':
            const lines = element.textContent.split('\n');
            lines.forEach((line, index) => {
                // encoder will flush on an empty line
                if (index == lines.length - 1) {
                    if (line) encoder.text(line);
                } else if (line) {
                    encoder.line(line);
                } else {
                    encoder.newline();
                }
            })
            break;
    }

    const children = Array.from(element.childNodes);
    for (let child of children) {
        await formatHTML(config, encoder, child);
    }
    if (after) after(encoder);
}

function resize(width, height) {
    const initial_width = width;

    // font A is 12 pixels, so we do 12 * # of columns to get the width in pixels
    const paper_width = config.printer.columns * 12;

    // resize to fit on the paper
    width = Math.min(width, paper_width);
    const scale = width / initial_width;
    height *= scale;

    // sizes must be a multiple of 8 pixels
    width = Math.round(width / 8) * 8;
    height = Math.round(height / 8) * 8;

    return [width, height]
}

async function main() {
    config.printer.createCanvas = createCanvas;
    
    config.pushover.secret ??= await login(config);
    config.pushover.id ??= await register(config);

    fs.writeFileSync('config.json', JSON.stringify(config, null, 2));

    await clearMessageQueue(config);

    listenForMessages(config);
}

main();