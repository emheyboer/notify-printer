#!/usr/bin/env node
require('dotenv').config({quiet: true});

const api_url = 'https://api.pushover.net/1';

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

async function main() {
    const email = process.env['EMAIL'];
    const password = process.env['PASSWORD'];
    const secret = process.env['SECRET'] || await login(email, password);

    console.log(`secret = ${secret}`);

    const name = process.env['NAME'];
    const id = process.env['ID'] || await register(secret, name);

    console.log(`id = ${id}`);
}

main();