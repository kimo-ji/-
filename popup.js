/* ======================================================================
 * popup.js —— 弹窗控制脚本
 * 读取/写入 chrome.storage.local 的"启用自动作答"开关。
 * 默认开启；切换后即时保存，content.js 通过 storage.onChanged 同步生效。
 * ====================================================================== */

(() => {
  'use strict';

  const checkbox = document.getElementById('enableToggle');

  // 读取已存状态，初始化复选框（未存过则默认勾选）
  chrome.storage.local.get('autoAnswerEnabled', (res) => {
    checkbox.checked = res.autoAnswerEnabled !== false;
  });

  // 切换时即时保存
  checkbox.addEventListener('change', () => {
    chrome.storage.local.set({ autoAnswerEnabled: checkbox.checked });
  });
})();
