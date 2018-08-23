const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const vm = require('vm');

const commonmark = require('commonmark');
const cheerio = require('cheerio');

// utils
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

function parseContent(content) {
	let readingKey = true;
	let readingValue = false;
	let key, value;
	let mark = 0;
	const parsed = {};
	for (let i = 0; i < content.length; i++) {
		switch (content[i]) {
			case '=':
				if (readingKey) {
					readingKey = false;
					key = content.substr(mark, i-mark);
					mark = i+1;
					readingValue = true;
				}
				break;
			case '\n':
				if (readingKey) {
					parsed.content = content.substr(mark);
					i = content.length;
					break;
				}
				readingValue = false;
				value = content.substr(mark, i-mark);

				parsed[key] = value;
				mark = i+1;
				readingKey = true;
				break;
		}
	}
	var reader = new commonmark.Parser();
	var writer = new commonmark.HtmlRenderer();
	parsed.content = writer.render(reader.parse(parsed.content));
	return parsed;
}

const contentCache = {};

function contentFromFile(filePath) {
	if (contentCache[filePath]) {
		return contentCache[filePath];
	}
	const parsed = parseContent(fs.readFileSync(filePath, 'utf8'));
	contentCache[filePath] = parsed;
	return parsed;
}

class Contents extends Array {
	constructor() {
		super(...arguments);
	}

	mostRecent(n, by='date') {
		return this
			.sort((left, right) => {
		        const ld = new Date(left[by]);
		        const rd = new Date(right[by]);
		        if (ld < rd) {
		          return 1;
		        } else if (ld > rd) {
		          return -1;
		        }
		        return 0;
		    })
		    .slice(0, n);
	}
}

function contentFromDirectory(dirPath) {
	return new Contents(...fs.readdirSync(dirPath).map(filePath => {
		return contentFromFile(path.join(dirPath, filePath));
	}));
}

function compile(filePath, ctx) {
	const data = cheerio.load(fs.readFileSync(filePath, 'utf8'), {_useHtmlParser2: true});
	data('script[compile="offline"]').each((idx, s) => {
		const result = vm.runInContext(cheerio(s).html(), ctx);
		cheerio(s).replaceWith(result);
	});
	return data.root();
}

// main
(async () => {
	if (!process.argv[2]) {
		console.error("project directory required");
		return;
	}
	const rootDir = process.argv[2];
	const rootStat = fs.statSync(rootDir);
	if (!rootStat.isDirectory()) {
		console.error("project directory required");
		return;
	}

	const configStr = await readFile(path.join(process.argv[2], 'config.json'), 'utf8')
	const config = JSON.parse(configStr);
	const srcDir = path.join(rootDir, 'src');

	const index = cheerio.load(await readFile(path.join(srcDir, 'index.html'), 'utf8'));
	const ctx = {
		'$': cheerio,
		'content': from => {
			const filePath = path.join(srcDir, from);
			const stat = fs.statSync(filePath);
			if (stat.isDirectory()) {
				return contentFromDirectory(filePath);
			}
			return contentFromFile(filePath);
		},
		'include': file => fs.readFileSync(path.join(srcDir, file), 'utf8'),
		'compile': file => compile(path.join(srcDir, file), ctx),
		'console': console,
		'config': config,
		'tween': (arr, value) => {
			const arrCopy = arr.slice();
			const origLen = arrCopy.length;
			const newLen = (origLen*2)-1;
			for (let i = 0; i < newLen-1; i+=2) {
				arrCopy.splice(i+1, 0, value);
			}
			return arrCopy;
		}
	};
	vm.createContext(ctx);

	try {
		const indexFile = config.src || "index.html";
		const index = compile(path.join(srcDir, indexFile), ctx);
		if (config.out) {
			const outDir = path.join(rootDir, config.out);
			if (!fs.existsSync(outDir)) {
				fs.mkdirSync(outDir);				
			}
			await writeFile(path.join(outDir, 'index.html'), index.html())
			console.log("updated", outDir);
		}
	} catch (err) {
		console.log("error compiling", err)
	}
})();
