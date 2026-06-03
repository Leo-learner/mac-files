const { ensureEnvFile, getConfig } = require('../config-panel');
const pkg = require('../package.json');

const created = ensureEnvFile(pkg.name);
const cfg = getConfig(pkg.name);
console.log(created ? `Created ${cfg.envPath}` : `${cfg.envPath} already exists`);
console.log('Configured fields:');
for (const field of cfg.fields) {
  console.log(`- ${field.key}=${field.value || '(empty)'}`);
}
for (const secret of cfg.secrets) {
  console.log(`- ${secret.key}: ${secret.masked}`);
}
