const fs = require('fs');
const path = require('path');
function walkSync(dir, filelist = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    if (['node_modules', '.next', '.git'].includes(file)) continue;
    const filepath = path.join(dir, file);
    if (fs.statSync(filepath).isDirectory()) {
      walkSync(filepath, filelist);
    } else if (filepath.endsWith('.ts') || filepath.endsWith('.tsx') || filepath.endsWith('.md')) {
      filelist.push(filepath);
    }
  }
  return filelist;
}
const files = walkSync('c:\\\\Renderbyte\\\\Monica\\\\src');
files.push('c:\\\\Renderbyte\\\\Monica\\\\README.md', 'c:\\\\Renderbyte\\\\Monica\\\\DESIGN.md');

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  let original = content;

  content = content.replace(/Dashboard de M[oó]nica/g, 'Dashboard de La Casa del Kioskero');
  content = content.replace(/>\s*MONICA\s*</g, '>LA CASA DEL KIOSKERO<');
  content = content.replace(/>\s*Monica\s*</g, '>La Casa del Kioskero<');
  content = content.replace(/>\s*M[oó]nica\s*</g, '>La Casa del Kioskero<');
  content = content.replace(/aria-label="Dashboard de M[oó]nica"/g, 'aria-label="Dashboard de La Casa del Kioskero"');
  content = content.replace(/STORY: Monica elige/g, 'STORY: La Casa del Kioskero elige');
  content = content.replace(/MONICA<span/g, 'LA CASA DEL KIOSKERO<span');
  content = content.replace(/<span className="brand-mark">M<\/span>/g, '<span className="brand-mark">LCQ</span>');
  content = content.replace(/Panel de operacion/g, 'Panel de operación'); // fixing another UI typo

  if (content !== original) {
    fs.writeFileSync(file, content, 'utf8');
    console.log('Branding updated in:', file);
  }
}
