import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const dest = path.join(root, 'android/app/src/main/assets/www');

fs.mkdirSync(path.join(dest, 'data'), { recursive: true });
fs.mkdirSync(path.join(dest, 'src'), { recursive: true });

fs.copyFileSync(path.join(root, 'index.html'), path.join(dest, 'index.html'));
fs.copyFileSync(path.join(root, 'styles.css'), path.join(dest, 'styles.css'));

for (const f of fs.readdirSync(path.join(root, 'data'))) {
  fs.copyFileSync(path.join(root, 'data', f), path.join(dest, 'data', f));
}

for (const f of fs.readdirSync(path.join(root, 'src'))) {
  fs.copyFileSync(path.join(root, 'src', f), path.join(dest, 'src', f));
}

console.log('Synchronized web assets to Android app bundle successfully.');
