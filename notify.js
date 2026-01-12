const config = require('./config.json');

const parameters = {
    token: config.pushover.token,
    user: config.pushover.user_key,
    title: 'title',
    message: 'message with <b>bold</b>, <u>underlined</u>, and <font color="#ffffff">inverted</font> text',
    url: 'https://example.com',
    url_title: 'example url',
    device: config.pushover.device_name,
    priority: 0,
    html: 1,
};

fetch('https://api.pushover.net/1/messages.json', {
    method: 'post',
    body: new URLSearchParams(parameters),
});