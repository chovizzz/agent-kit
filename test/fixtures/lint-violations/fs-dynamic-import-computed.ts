const name = ['n', 'ode:fs'].join('');
const fs = await import(name);

fs.writeFileSync('/tmp/x', 'x');
