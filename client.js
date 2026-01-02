#!/usr/bin/env node
require('dotenv').config({quiet: true});
const fs = require('fs');
const spawn = require('child_process').spawn;
const {JSDOM} = require("jsdom");
const ReceiptPrinterEncoder = require('@point-of-sale/receipt-printer-encoder')

const api_url = 'https://api.pushover.net/1';
const websocket_url = 'wss://client.pushover.net/push';
const user_agent = 'notify-printer';

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
        email: config.email,
        password: config.password,
    };

    const json = await retryFetch(api_url + '/users/login.json', {
        method: 'post',
        headers: {
            'User-Agent': user_agent,
        },
        body: new URLSearchParams(parameters),
    }).then(res => res.json());
    check(json);

    fs.appendFileSync('.env', `\nSECRET=${json.secret}`);

    return json.secret;
}

async function register(config) {
    console.log('registering device...');

    const parameters = {
        secret: config.secret,
        name: config.name,
        os: 'O',
    };

    const json = await retryFetch(api_url + '/devices.json', {
        method: 'post',
        headers: {
            'User-Agent': user_agent,
        },
        body: new URLSearchParams(parameters),
    }).then(res => res.json());
    check(json);

    fs.appendFileSync('.env', `\nID=${json.id}\n`);

    return json.id;
}

async function getMessages(config) {
    const parameters = {
        secret: config.secret,
        device_id: config.id,
    };

    const json = await retryFetch(api_url + '/messages.json?' + new URLSearchParams(parameters), {
        method: 'get',
        headers: {
            'User-Agent': user_agent,
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
        secret: config.secret,
        message: highest_message,
    };

    const json = await retryFetch(api_url + `/devices/${config.id}/update_highest_message.json`, {
        method: 'post',
        headers: {
            'User-Agent': user_agent,
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
        socket.send(`login:${config.id}:${config.secret}\n`);
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

    messages.forEach(message => {
        const {text, encoder} = formatMessage(config, message);
        console.log();
        console.log(text);
        sendToPrinter(config, encoder);
    });
}

function sendToPrinter(config, data) {
    if (typeof data == 'string') {
        data = new ReceiptPrinterEncoder(config.printer_config)
            .initialize()
            .codepage('auto')
            .line(data);
    }

    const child = spawn('lp', ['-d', config.printer, '-o', 'raw']);
    child.stdin.write(' '.repeat(80) + '\n');
    child.stdin.write(data.cut().encode());
    child.stdin.end();
}

function formatMessage(config, message) {
    const title = message.title ?? message.app;
    let text = title;
    const encoder = new ReceiptPrinterEncoder(config.printer_config)
        .initialize()
        .codepage('auto')
        .bold(true)
        .line(title)
        .bold(false);

    let body = message.message;
    if (message.html == 1) {
        const {document} = new JSDOM(message.message).window;
        body = document.body.textContent ?? body;
    }

    // remove leading and trailing whitespace
    body = body.trim().split('\n').map(line => line.trim()).join('\n');

    // collapse whitespace
    body = body.replaceAll('\t', ' ').replaceAll(/ {2,}/g, ' ');

    text += '\n' + body;
    encoder.line(body);

    if (message.url) {
        encoder.qrcode(message.url)
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

async function main() {
    const config = {
        email: process.env['EMAIL'],
        password: process.env['PASSWORD'],
        name: process.env['NAME'],
        printer: process.env['PRINTER'],
        printer_config: {
            columns: 32,
            feedBeforeCut: 2,
        }
    }
    config.secret = process.env['SECRET'] || await login(config);
    config.id = process.env['ID'] || await register(config);

    await clearMessageQueue(config);

    listenForMessages(config);
}

main();