const config = require('../config.json');

const parameters = {
    token: config.pushover.token,
    user: config.pushover.user_key,
    title: 'title',
    message: `<h1>h1</h1>
<h2>h2</h2>
<h3>h3</h3>
<pre>monospace</pre>
<b>bold</b>
<i>italic</i>
<u>underline</u>
<mark>invert</mark>
<strike>strike</strike>
<small>small</small>
hr
<hr>
<ul>
    <li>one</li>
    <li>two</li>
    <li>three</li>
</ul>
<img src="https://raw.githubusercontent.com/emheyboer/notify-printer/refs/heads/main/images/printer.jpg">
<a href="https://example.com/">example url</a>`,
    device: config.pushover.name,
    priority: 0,
    html: 1,
};

fetch('https://api.pushover.net/1/messages.json', {
    method: 'post',
    body: new URLSearchParams(parameters),
});