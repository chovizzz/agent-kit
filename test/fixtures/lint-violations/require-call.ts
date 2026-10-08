declare function require(name: string): { writeFileSync(p: string, d: string): void };

require('fs').writeFileSync('/tmp/x', 'x');
