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

function contentFromFile(dirPath, relPath) {
	const absPath = path.join(dirPath, relPath);
	let parsed;
	if (contentCache[absPath]) {
		parsed = contentCache[absPath];
	} else {
		parsed = parseContent(fs.readFileSync(absPath, 'utf8'));
		contentCache[absPath] = parsed;
	}
	const extIdx = relPath.lastIndexOf('.');
	parsed.fileName = extIdx < 0 ? path.basename(relPath) : path.basename(relPath.substr(0, extIdx));
	parsed.baseFileName = extIdx < 0 ? relPath : relPath.substr(0, extIdx);
	parsed.relPath = relPath;
	return parsed;
}

class Contents extends Array {
	constructor() {
		super(...arguments);
	}

	mostRecent(n=0, by='date') {
		if (n <= 0 || n === undefined) {
			n = this.length;
		}
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

function contentFromDirectory(baseDir, relPath) {
	const dirPath = path.join(baseDir, relPath);
	return new Contents(...fs.readdirSync(dirPath).map(filePath => {
		return contentFromFile(baseDir, path.join(relPath, filePath));
	}));
}

class Queue {
	constructor() {
		this.q = new Array();
	}

	enqueue(elem) {
		this.q.unshift(elem);
	}

	dequeue() {
		return this.q.pop();
	}

	isEmpty() {
		return this.q.length === 0;
	}
}

function mkdirRSync(mkpath) {
	if (mkpath.length === 0) {
		return;
	}
	const lof = mkpath.lastIndexOf(path.sep);
	if (lof != -1) {
		mkdirRSync(mkpath.substr(0, lof))
	}
	if (!fs.existsSync(mkpath)) {
		fs.mkdirSync(mkpath);
	}
}

class Compiler {
	constructor(srcDir, vmCtx, compileQueue) {
		this.srcDir = srcDir;
		this.cwd = '';
		this.vmCtx = vmCtx;
		this.compileQueue = compileQueue;
		this.cache = {};

		// extend ctx
		this.vmCtx.compile = this.compile.bind(this);
	}

	compile(filePath) {
		const absPath = path.join(this.cwd, filePath);
		if (this.cache[absPath]) {
			return this.cache[absPath];
		}
		let result;
		switch (path.extname(filePath)) {
			case '.md': {
				const content = contentFromFile(this.cwd, filePath);
				if (!content.template) {
					throw new Error("content missing template; cannot compile");
				}
				const templateFile = path.join(this.srcDir, 'templates', content.template);
				const data = cheerio.load(fs.readFileSync(templateFile, 'utf8'), {_useHtmlParser2: true});
				const localCtx = vm.createContext({ ...this.vmCtx });
				localCtx.content = content;
				data('script[compile]').each((idx, s) => {
					const result = vm.runInContext(`{${cheerio(s).html()}}`, localCtx);
					cheerio(s).replaceWith(result);
				});
				result = [data.html(), filePath.substr(0, filePath.lastIndexOf('.')) + ".html"];
				break;
			};
			case '.html': {
				const data = cheerio.load(fs.readFileSync(absPath, 'utf8'), {_useHtmlParser2: true});
				data('script[compile]').each((idx, s) => {
					const result = vm.runInContext(`{${cheerio(s).html()}}`, this.vmCtx);
					cheerio(s).replaceWith(result);
				});
				data('a[compile-ref]').each((idx, t) => {
					if (!this.compileQueue) {
						return;
					}
					const ref = cheerio(t).attr('compile-ref');
					cheerio(t).removeAttr('compile-ref');
					if (!this.cache[path.join(this.cwd, ref)]) {
						this.compileQueue.enqueue([this.cwd, ref]);						
					}
				})
				result = data.html();
				break;
			};
			default:
				throw new Error("do not know how to compile " + filePath);
		}
		this.cache[absPath] = result;
		return result;
	}
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

	const ctx = {
		'$': cheerio,
		'content': from => {
			const filePath = path.join(srcDir, from);
			const stat = fs.statSync(filePath);
			if (stat.isDirectory()) {
				return contentFromDirectory(srcDir, from);
			}
			return contentFromFile(srcDir, from);
		},
		'include': file => fs.readFileSync(path.join(srcDir, file), 'utf8'),
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

	const indexRelPath = config.src || "index.html";

	const compileQueue = new Queue();
	compileQueue.enqueue([srcDir, indexRelPath]);
	const compiler = new Compiler(srcDir, ctx, compileQueue);

	while (!compileQueue.isEmpty()) {
		let [baseDir, relPath] = compileQueue.dequeue();
		compiler.cwd = baseDir;
		try {
			let file = compiler.compile(relPath);
			if (config.out) {
				const outDir = path.join(rootDir, config.out);
				if (file instanceof Array) {
					relPath = file[1];
					file = file[0];
				}
				const outPath = path.join(outDir, relPath);
				mkdirRSync(path.dirname(outPath));
				await writeFile(outPath, file)
				console.info("updated", outPath);
			}
		} catch (err) {
			console.error("error compiling", err)
		}
	}
})();
