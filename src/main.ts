import './styles.css';
import { boot } from './ui/app';

boot().catch((err: unknown) => {
  const log = document.getElementById('boot-log');
  if (log) log.textContent += `\nBOOT FAILED: ${err instanceof Error ? err.message : String(err)}\nReload the page to try again.`;
  console.error(err);
});
