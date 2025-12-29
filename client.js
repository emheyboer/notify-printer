#!/usr/bin/env node
require('dotenv').config({quiet: true});
const fs = require('fs');
const spawn = require('child_process').spawn;

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
        console.error(`error (status = ${response.status}): ${error}`);
    })
    process.exit();
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

    const socket = new WebSocket(websocket_url);

    socket.addEventListener('open', event => {
        socket.send(`login:${config.id}:${config.secret}\n`);
    });

    socket.addEventListener('message', async event => {
        const frame_type = await event.data.text();

        switch (frame_type) {
            case Frame.KeepAlive:
                break;
            case Frame.NewMessage:
                onNewMessage(config);
                break;
            case Frame.Reload:
                console.log('reconnecting...');
                socket.close();
                listenForMessages(config);
                break;
            case Frame.PermanentError:
            case Frame.OtherSessionLoggedIn:
                console.log('disconnecting...');
                socket.close();
                break;
        }
    });

    socket.addEventListener('close', event => {
        console.log('connection closed');
    });

    socket.addEventListener('error', error => {
        console.error(`error: ${error}`);
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
        const title = message.title ?? message.app;
        console.log();
        console.log(title);
        console.log('-'.repeat(60));
        console.log(message.message);

        const child = spawn('lp', ['-d', config.printer, '-o', 'raw']);
        const printed = `${' '.repeat(80)}\n${title}\n${message.message}${'\n'.repeat(3)}`;
        child.stdin.write(printed);
        child.stdin.end();
    });
}

async function main() {
    const config = {
        email: process.env['EMAIL'],
        password: process.env['PASSWORD'],
        name: process.env['NAME'],
        printer: process.env['PRINTER'],
    }
    config.secret = process.env['SECRET'] || await login(config);
    config.id = process.env['ID'] || await register(config);

    await clearMessageQueue(config);

    listenForMessages(config);
}

main();