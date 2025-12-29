#!/usr/bin/env node
require('dotenv').config({quiet: true});
const spawn = require('child_process').spawn;

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
    response.errors.forEach(error => {
        console.error(`error (status = ${response.status}): ${error}`);
    })
    console.log('shutting down...');
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

async function login(email, password) {
    console.log('logging in...');

    const parameters = {
        email: email,
        password: password,
    };

    const json = await retryFetch(api_url + '/users/login.json', {
        method: 'post',
        body: new URLSearchParams(parameters),
    }).then(res => res.json());
    check(json);

    return json.secret;
}

async function register(secret, name) {
    console.log('registering device...');

    const parameters = {
        secret: secret,
        name: name,
        os: 'O',
    };

    const json = await retryFetch(api_url + '/devices.json', {
        method: 'post',
        body: new URLSearchParams(parameters),
    }).then(res => res.json());
    check(json);

    return json.id;
}

async function downloadMessages(secret, id) {
    const parameters = {
        secret: secret,
        device_id: id,
    };

    const json = await retryFetch(api_url + '/messages.json?' + new URLSearchParams(parameters), {
        method: 'get',
    }).then(res => res.json());
    check(json);

    return json.messages;
}

async function deleteMessages(secret, id, messages) {
    if (!messages.length) return;

    const message_ids = messages.map(message => BigInt(message.id_str));
    const highest_message = message_ids.reduce((max, n) => n > max ? n : max);

    const parameters = {
        secret: secret,
        message: highest_message,
    };

    const json = await retryFetch(api_url + `/devices/${id}/update_highest_message.json`, {
        method: 'post',
        body: new URLSearchParams(parameters),
    }).then(res => res.json());
    check(json);
}

function listenForMessages(secret, id) {
    console.log('listening for messages...');

    const socket = new WebSocket(websocket_url);

    socket.addEventListener('open', event => {
        socket.send(`login:${id}:${secret}\n`);
    });

    socket.addEventListener('message', async event => {
        const frame_type = await event.data.text();

        switch (frame_type) {
            case Frame.KeepAlive:
                break;
            case Frame.NewMessage:
                onNewMessage(secret, id);
                break;
            case Frame.Reload:
                console.log('reconnecting...');
                socket.close();
                listenForMessages(secret, id);
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

async function clearMessageQueue(secret, id) {
    console.log('clearing message queue...');
    const messages = await downloadMessages(secret, id);
    await deleteMessages(secret, id, messages);
}

async function onNewMessage(secret, id) {
    const messages = await downloadMessages(secret, id);
    await deleteMessages(secret, id, messages);

    messages.forEach(message => {
        const title = message.title ?? message.app;
        console.log();
        console.log(title);
        console.log('-'.repeat(60));
        console.log(message.message);

        const child = spawn('lp', ['-d', process.env['PRINTER'], '-o', 'raw']);
        const printed = `${' '.repeat(80)}\n${title}\n${message.message}${'\n'.repeat(3)}`;
        child.stdin.write(printed);
        child.stdin.end();
    });
}

async function main() {
    const email = process.env['EMAIL'];
    const password = process.env['PASSWORD'];
    const secret = process.env['SECRET'] || await login(email, password);

    const name = process.env['NAME'];
    const id = process.env['ID'] || await register(secret, name);

    await clearMessageQueue(secret, id);

    listenForMessages(secret, id);
}

main();