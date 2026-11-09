import { bootContent } from './controller';
import { mountPanel } from './ui';

const controller = bootContent();
if (controller) {
  chrome.runtime.onMessage.addListener((request: unknown, _sender, respond) => {
    if (!request || typeof request !== 'object' || !('type' in request) || request.type !== 'courseHelper') return;
    const result = controller.handle(request as Record<string, unknown>);
    if (result instanceof Promise) {
      void result.then(respond, () => respond({ error: '页面操作未完成，请检查课程页。' }));
      return true;
    }
    if (result !== undefined) respond(result);
  });
}
if (window === window.top) {
  mountPanel(message => chrome.runtime.sendMessage({ ...message, type: 'courseHelperPanel' }));
}
