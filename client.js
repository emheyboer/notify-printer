const fs = require('fs');
const { spawn } = require('child_process');
const { createCanvas } = require('canvas');
const ReceiptPrinterEncoder = require('@point-of-sale/receipt-printer-encoder');

const { drawMessage } = require('./rendering.js');
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
    if (response.status == 1) return;
    response.errors && response.errors.forEach(error => {
        console.error(`error (status = ${response.status}):`, error);
    });
    process.exit(response.status || 1);
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
        if (message.priority < config.min_priority) return;
 
        console.log(JSON.stringify(message, null, 2));
        const encoder = await encodeMessage(config, message);
        sendToPrinter(config, encoder);
    }
}

function sendToPrinter(config, data) {
    if (!config.printer.enabled) return;
    if (config.debug) console.time('print');
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

    if (config.debug) console.timeEnd('print');
}

async function encodeMessage(config, message) {
    if (config.debug) console.time('encode message');

    const canvas = createCanvas(config.printer.paper_width, 1e4);
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    let [x, y] = [0, 0];

    if (config.debug) console.time('draw message');
    [x, y] = await drawMessage(ctx, x, y, message);
    if (config.debug) console.timeEnd('draw message');
           
    let height = y + 10;
    height = (height + 7) >> 3 << 3;
    const imageData = ctx.getImageData(0, 0, ctx.canvas.width, height);

    if (config.canvas.save) {
        canvas.height = height;
        ctx.putImageData(imageData, 0, 0);
        saveCanvas(config, ctx);
    }

    const encoder = new ReceiptPrinterEncoder(config.printer)
        .initialize()
        .image(imageData, ctx.canvas.width, height, 'atkinson');

    if (config.debug) console.timeEnd('encode message');
    return encoder;
}

async function saveCanvas(config, ctx) {
    const buffer = ctx.canvas.toBuffer('image/png');
    const folder = config.canvas.folder;
    try {
        fs.mkdirSync(folder);
    } catch (err) {
        if (err.code != 'EEXIST') throw err;
    }
    const filename = `${new Date().toISOString()}.png`;
    fs.writeFileSync(`${folder}/${filename}`, buffer);

    const link = `${folder}/latest.png`;
    try {
        fs.unlinkSync(link);
    } catch (err) {
        if (err.code != 'ENOENT') throw err;
    }
    try {
        fs.symlinkSync(filename, link);
    } catch (err) {
        if (err.code != 'EEXIST') throw err;
    }
}

async function main() {
    config.printer ||= {};
    config.printer.columns ??= 32; // a fairly safe default
    // font A is 12 pixels wide, so # of columns * 12 gives us the available width in pixels
    config.printer.paper_width ??= config.printer.columns * 12;
    config.printer.enabled ??= true;

    config.canvas ||= {};

    config.min_priority = isNaN(config.min_priority) ? -Infinity : config.min_priority;
    
    config.pushover ||= {};
    config.pushover.secret ||= await login(config);
    config.pushover.id ||= await register(config);

    fs.writeFile('config.json', JSON.stringify(config, null, 2), err => {
        if (err) throw err;
    });

    await clearMessageQueue(config);

    listenForMessages(config);
}

main();