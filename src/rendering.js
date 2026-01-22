const { createCanvas, loadImage } = require('canvas');
const {JSDOM} = require("jsdom");
const QRCode = require('qrcode');
const { wrapLines } = require('./wrapping.js');

function drawText(ctx, x, y, text, options = {}) {
    options.scale ||= 1;
    if (options.scale > 1) options.newline = true;

    ctx.font = [
        options.italic ? 'italic' : '',
        options.bold ? 'bold' : '',
        30 * options.scale + 'px',
        options.monospace ? 'monospace' : 'sans-serif',
    ].join(' ');

    const color = options.invert ? '#fff' : '#000';

    const measurements = ctx.measureText('');
    const line_height = measurements.emHeightAscent + measurements.emHeightDescent;

    const lines = wrapLines(ctx, x, text);

    if (!lines.length) return [x, y];

    y += line_height;
    let line;
    let width;
    for (i in lines) {
        if (i > 0) {
            x = 0;
            y += line_height;
        };
        line = lines[i];

        width = ctx.measureText(line).width;

        if (options.invert) {
            ctx.fillStyle = '#000';
            ctx.fillRect(x, y + measurements.emHeightDescent, width, -line_height);
        }

        ctx.fillStyle = color;
        ctx.fillText(line, x, y);

        if (options.strike) ctx.fillRect(x, y - measurements.emHeightAscent / 3, width, 2);
        if (options.underline) ctx.fillRect(x, y, width, 2);
    }

    if (options.newline) {
        x = 0;
    } else {
        x += width;
        y -= line_height;
    }

    return [x, y]
}


function newline(ctx, x, y, safe = false) {
    if (x > 0) {
        [x, y] = drawText(ctx, x, y, '', {newline: true});
    }
    if (safe) { // for rending elements that may otherwise cutoff preceding text
        y += ctx.measureText('').emHeightDescent;
    }
    return [x, y];
}

async function drawQRCode(ctx, x, y, data) {
    const canvas = createCanvas(1, 1);
    await QRCode.toCanvas(canvas, data);
    const [dx, dy] = resize(ctx.canvas.width, canvas.width, canvas.height);
    [x, y] = newline(ctx, x, y, true);
    ctx.drawImage(canvas, x, y, dx, dy);
    return [0, y + dy];
}

async function drawImage(ctx, x, y, src) {
    const url = new URL(src);
    if (url.protocol != 'https:') return [x, y];

    const image = await loadImage(url.href);
    const [dx, dy] = resize(ctx.canvas.width, image.width, image.height);
    [x, y] = newline(ctx, x, y, true);
    ctx.drawImage(image, x, y, dx, dy);
    return [0, y + dy];
}

function resize(max_width, width, height) {
    const initial_width = width;

    // resize to fit on the paper
    width = Math.min(width, max_width);
    const scale = width / initial_width;
    height *= scale;

    // sizes must be a multiple of 8 pixels
    width = (width + 7) >> 3 << 3;
    height = (height + 7) >> 3 << 3;

    return [width, height]
}

async function drawHTML(ctx, x = 0, y = 0, element, options) {
    options = structuredClone(options);
    switch (element.nodeName) {
        case 'STRONG':
        case 'B':
            options.bold = true;
            break;
        case 'EM':
        case 'I': // italics aren't supported by most printers
            options.italic = true;
            break;
        case 'U':
            options.underline = true;
            break;
        case 'STRIKE':
            options.strike = true;
            break;
        case 'FONT': // instead of attempting to apply a font color, we just switch to white-on-black
            if (element.color && element.color != '#000000') {
                options.invert = true;
            }  
            break;
        case 'MARK':
            options.invert = true;
            break;
        case 'PRE':
            options.monospace = true;
            break;
        case 'A':
            [x, y] = await drawQRCode(ctx, x, y, element.href);
            break;
        case 'HR':
            ctx.fillRect(0, y, ctx.canvas.width, 2);
            break;
        case 'BR':
            [x, y] = newline(ctx, x, y);
            break;
        case 'LI':
            [x, y] = drawText(ctx, x, y, '• ');
            break;
        case 'H1':
            options.scale = 2;
            break;
        case 'H2':
            options.scale = 1.5;
            break;
        case 'H3':
        case 'BIG':
            options.scale = 1.25;
            break;
        case 'SMALL':
            options.scale = 0.75;
            break;
        case 'IMG':
            try {
                [x, y] = await drawImage(ctx, x, y, element.src);
            } catch {
                [x, y] = await drawQRCode(ctx, x, y, element.src);
            }
            break;
        case 'VIDEO':
        case 'AUDIO':
        case 'EMBED':
            [x, y] = await drawQRCode(ctx, x, y, element.src);
            break;
        case 'OBJECT':
            [x, y] = await drawQRCode(ctx, x, y, element.data);
            break;
        case '#text':
            const lines = element.textContent.split('\n');
            lines.forEach((line, i) => {
                [x, y] = drawText(ctx, x, y, line, {...options, newline: i != lines.length - 1});
            });
            break;
    }

    const children = Array.from(element.childNodes);
    for (let child of children) {
        [x, y] = await drawHTML(ctx, x, y, child, options);
    }

    return [x, y];
}

async function drawMessage(ctx, x, y, message) {
    const title = message.title ?? message.app;
    [x, y] = drawText(ctx, x, y, title, {bold: true, newline: true});

    y += ctx.measureText('').emHeightDescent;
    ctx.fillRect(0, y, ctx.canvas.width, 2);
    y += 2;

    const body = message.message;
    if (message.html == 1) {
        const {document} = new JSDOM(body).window;
        [x, y] = await drawHTML(ctx, x, y, document, {});
    } else {
        [x, y] = drawText(ctx, x, y, body, {
            monospace: message.monospace == 1,
        });
    }

    if (message.url) {
        [x, y] = await drawQRCode(ctx, x, y, message.url);
        [x, y] = drawText(ctx, x, y, message.url_title || message.url);
    }

    [x, y] = newline(ctx, x, y, true);

    return [x, y]
}

module.exports = {drawMessage};