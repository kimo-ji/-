/* ======================================================================
 * inject.js —— 页面上下文(MAIN world)注入：覆盖 isTrusted
 * ----------------------------------------------------------------------
 * 智慧树"AI随堂练习"弹窗的选项点击处理器检查 event.isTrusted，
 * 拒绝所有脚本合成的事件（.click() / dispatchEvent）。
 *
 * 本脚本在 document_start 阶段、页面上下文(MAIN world)中运行，
 * 将 Event.prototype.isTrusted 的 getter 改为始终返回 true，
 * 使 content.js 派发的合成点击事件能通过校验、正常选中选项。
 *
 * 原理：isTrusted 是 Event.prototype 上的只读 IDL 属性，
 *       原始描述符 configurable=true，可用 Object.defineProperty 覆盖。
 *       覆盖后，页面任何事件监听器读取 event.isTrusted 均得到 true。
 * ====================================================================== */
(() => {
  'use strict';
  try {
    Object.defineProperty(Event.prototype, 'isTrusted', {
      get() { return true; },
      configurable: true,
    });
    // 在 <html> 上留标记，供 content.js 验证注入是否成功
    document.documentElement.dataset.zhihuishuInjected = '1';
    console.log('[zhihuishu-auto] inject.js: isTrusted 已覆盖');
  } catch (e) {
    console.warn('[zhihuishu-auto] inject.js: isTrusted 覆盖失败', e);
  }
})();
