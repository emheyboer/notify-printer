function wrapLines(ctx, x, text) {
    if (x > 0 && !text) return [''];
    
    const width = {
        ' ': ctx.measureText(' ').width,
    };
    if (x > 0) x += width[' '];

    const max_width = ctx.canvas.width;

    const input_lines = text.split('\n');
    let output_lines = [];

    if (x > max_width) {
        output_lines.push('');
        x = 0;
    }

    for (let line of input_lines) {
        const words = line.split(/\s/).map((word, i) => i > 0 ? ' ' + word : word).reverse();

        line = '';
        while (words.length) {
            const word = words.pop();
            width[word] ||= ctx.measureText(word).width;

            if (width[word] > max_width) {
                words.push(...word.split('').reverse());
            } else if (x + width[word] > max_width) {
                output_lines.push(line);
                x = 0;
                line = word.trimLeft();
                width[line] ||= ctx.measureText(line).width;
                x = width[line];
            }  else {
                line += word;
                x += width[word];
            }
        }
        if (line) output_lines.push(line);
    }

    return output_lines;
}

module.exports = {wrapLines};