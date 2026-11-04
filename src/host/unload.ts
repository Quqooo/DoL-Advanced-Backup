/**
 * 写存储期间拦下误刷新。
 *
 * 浏览器只提供 `beforeunload` 这一种手段：它不阻止离开，只在离开前弹出确认，
 * 文案由浏览器决定。所以这里的语义是提醒，不是锁定。
 */

let holds = 0;
let listening = false;

function onBeforeUnload(event: BeforeUnloadEvent): void {
  // Chrome 119 起认 preventDefault，更早的版本与 Firefox 靠 returnValue
  event.preventDefault();
  event.returnValue = '';
}

/**
 * 进入一段写存储的任务，返回释放函数；重复调用安全。
 *
 * 用计数而不是布尔：三个分页各自独立，一个任务的收尾不能解除另一个的守卫。
 */
export function holdUnload(): () => void {
  holds += 1;
  if (!listening) {
    window.addEventListener('beforeunload', onBeforeUnload);
    listening = true;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    if (holds === 0 && listening) {
      window.removeEventListener('beforeunload', onBeforeUnload);
      listening = false;
    }
  };
}
