const {spawnSync} = require('node:child_process');
const path = require('node:path');

for (const suite of ['controls.cjs', 'reviews.cjs', 'markdown.cjs', 'host-state.cjs', 'note-keyboard.cjs', 'reordering.cjs', 'review-fixes.cjs', 'lifecycle.cjs', 'milestones.cjs', 'plan-review.cjs', 'handovers.cjs']) {
  const result = spawnSync(process.execPath, [path.join(__dirname,suite)], {stdio:'inherit'});
  if (result.error) console.error(result.error.message);
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
