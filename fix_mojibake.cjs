const fs = require('fs');
const path = require('path');

const replacements = {
  'Ã¡': 'á',
  'Ã©': 'é',
  'Ã­': 'í',
  'Ã³': 'ó',
  'Ãº': 'ú',
  'Ã±': 'ñ',
  'Ã\x81': 'Á', // Ã
  'Ã‰': 'É',
  'Ã\x8D': 'Í', // Ã
  'Ã“': 'Ó',
  'Ãš': 'Ú',
  'Ã‘': 'Ñ',
  'Â·': '·',
  'â€”': '—',
  'â†’': '→',
  'â†‘': '↑',
  'â†“': '↓',
  'â€¦': '…'
};

function walkSync(dir, filelist = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    if (file === 'node_modules' || file === '.next' || file === '.git') continue;
    const filepath = path.join(dir, file);
    if (fs.statSync(filepath).isDirectory()) {
      walkSync(filepath, filelist);
    } else {
      if (filepath.endsWith('.ts') || filepath.endsWith('.tsx') || filepath.endsWith('.json') || filepath.endsWith('.js') || filepath.endsWith('.md')) {
        filelist.push(filepath);
      }
    }
  }
  return filelist;
}

const files = walkSync('c:\\\\Renderbyte\\\\Monica\\\\src');
files.push('c:\\\\Renderbyte\\\\Monica\\\\package.json');

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  let original = content;
  for (const [bad, good] of Object.entries(replacements)) {
    content = content.split(bad).join(good);
  }
  
  if (content !== original) {
    fs.writeFileSync(file, content, 'utf8');
    console.log('Fixed:', file);
  }
}
