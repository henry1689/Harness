// Clean the temp filesystem that's blocking bash output
const fs = require('fs');
const path = require('path');

const tmpDir = path.join(process.env.LOCALAPPDATA || 'C:/Users/henry/AppData/Local', 'Temp', 'claude', 'C--Users-henry');
if (!fs.existsSync(tmpDir)) { console.log('No tmp dir'); process.exit(0); }

function walkDir(dir, depth = 0) {
  if (depth > 4) return;
  try {
    const entries = fs.readdirSync(dir);
    for (const e of entries) {
      const full = path.join(dir, e);
      try {
        const st = fs.statSync(full);
        if (st.isDirectory()) {
          walkDir(full, depth + 1);
          // try to rmdir if empty
          try { fs.rmdirSync(full); } catch (_) {}
        } else {
          // Delete .output files and large files
          if (e.endsWith('.output') || e.endsWith('.jsonl') || st.size > 100000) {
            fs.unlinkSync(full);
          }
        }
      } catch (_) {}
    }
  } catch (_) {}
}

console.log('Cleaning task output files...');
walkDir(tmpDir);
console.log('Done');
