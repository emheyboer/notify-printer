require('dotenv').config({quiet: true});

const parameters = {
    token: process.env['TOKEN'],
    user: process.env['USER_KEY'],
    title: 'title',
    message: 'message with <b>bold</b>, <u>underlined</u>, and <font color="#ffffff">inverted</font> text',
    url: 'https://example.com',
    url_title: 'example url',
    device: process.env['DEVICE_NAME'],
    priority: 0,
    html: 1,
};

fetch('https://api.pushover.net/1/messages.json', {
    method: 'post',
    body: new URLSearchParams(parameters),
});