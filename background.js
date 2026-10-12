/* ======================================================================
 * background.js —— Service Worker：通过 chrome.debugger 发送"真实点击"
 * ----------------------------------------------------------------------
 * 为什么需要：智慧树"AI随堂练习"弹窗的选项处理器校验 event.isTrusted，
 * 拒绝一切脚本合成事件（.click()/dispatchEvent 派发的事件 isTrusted=false，
 * 且页面 CSP 拦截了所有覆盖 isTrusted 的注入尝试）。
 * chrome.debugger 的 Input.dispatchMouseEvent 在渲染层生成"真实输入事件"，
 * 与用户手点完全一致（isTrusted=true），页面无法区分。
 *
 * 流程（v1.2.2 起改为"两阶段协议"）：
 *   阶段1 cdpAttach —— content.js 量坐标"之前"先请求附加：附加会触发浏览器
 *                     顶部"已开始调试"提示条、网页可视区被压低而整体位移，
 *                     必须让这次位移先发生再量坐标，否则坐标全部偏移点空；
 *   阶段2 cdpClicks —— 派发真实点击（调试器已附加则保持附加，供提交按钮、
 *                     反馈按钮继续复用；未附加则自行附加并在结束后分离）；
 *   阶段3 cdpDetach —— 整个作答流程结束，分离调试器，提示条随之消失。
 * 注意：同一标签页若开着 DevTools(F12)，attach 会失败（CDP 只允许一个
 *       调试端），此时返回失败，由 content.js 走合成事件回退。
 *
 * v1.2.4 新增：把 iframe 内播放器发来的"视频播完"(videoEnded) 转发为
 *              navigateNext 广播到该标签页所有框架，由顶层框架的
 *              content script 执行"自动切换下一节"（侧边栏在顶层文档）。
 * ====================================================================== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Promise 化 chrome.debugger API ----------
function attachDebugger(debuggee) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(debuggee, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}
function detachDebugger(debuggee) {
  return new Promise((resolve) => {
    chrome.debugger.detach(debuggee, () => {
      void chrome.runtime.lastError; // 已分离等情况忽略
      resolve();
    });
  });
}
function dispatchMouse(debuggee, params) {
  return new Promise((resolve, reject) => {
    // v1.2.29：3 秒超时兜底。开着 F12 时 DevTools 会抢占调试器会话，
    // sendCommand 可能永不回调（既不成功也不报错），导致 content.js
    // 等满 15 秒超时才回退合成点击、弹窗长时间卡住。加超时后 3 秒
    // 内未响应即 reject，content.js 快速走回退路径。
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('dispatchMouse 超时（3s，可能被 F12 抢占调试器）'));
    }, 3000);
    chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', params, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

// 在扩展图标上显示状态角标（DevTools 关闭时用户也能看到结果）
function setBadge(tabId, text, color) {
  try {
    chrome.action.setBadgeText({ tabId, text });
    chrome.action.setBadgeBackgroundColor({ tabId, color });
    setTimeout(() => {
      try { chrome.action.setBadgeText({ tabId, text: '' }); } catch (e) { /* SW 已休眠则忽略 */ }
    }, 4000);
  } catch (e) { /* 忽略角标失败 */ }
}

// 当前已附加调试器的标签页集合（在多条消息间维护附加状态）
const attachedTabs = new Set();

// 外部原因导致分离（用户点掉提示条"取消"、DevTools 抢占等）时同步状态，
// 避免集合与实际附加情况不一致
chrome.debugger.onDetach.addListener((debuggee) => {
  attachedTabs.delete(debuggee.tabId);
});

// ---------- 消息入口：处理来自 content.js 的调试/点击请求 ----------
// 三种消息：cdpAttach（仅附加） / cdpClicks（派发真实点击） / cdpDetach（分离）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !['cdpAttach', 'cdpClicks', 'cdpDetach', 'resumeVideo', 'videoEnded',
    'videoProbe', 'videoProbeResult'].includes(msg.type)) return;

  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) {
    sendResponse({ ok: false, error: '无法确定来源标签页' });
    return;
  }
  const debuggee = { tabId };

  // ---- 阶段 1：仅附加调试器，不点击 ----
  if (msg.type === 'cdpAttach') {
    (async () => {
      if (attachedTabs.has(tabId)) {
        sendResponse({ ok: true }); // 幂等：已附加直接成功
        return;
      }
      try {
        await attachDebugger(debuggee);
      } catch (e) {
        const m = String(e && e.message || e);
        // 已处于附加状态（如 SW 重启导致集合丢失）→ 视为成功
        if (!/already|attached/i.test(m)) {
          sendResponse({ ok: false, error: m });
          return;
        }
      }
      attachedTabs.add(tabId);
      sendResponse({ ok: true });
    })();
    return true;
  }

  // ---- 阶段 2：派发真实点击 ----
  if (msg.type === 'cdpClicks') {
    let owned = !attachedTabs.has(tabId); // 是否由本次请求自行附加调试器
    (async () => {
      try {
        if (owned) {
          try {
            await attachDebugger(debuggee);
          } catch (e) {
            const m = String(e && e.message || e);
            // 实际仍附加中（如 SW 重启丢状态）→ 复用既有会话继续
            if (!/already|attached/i.test(m)) throw e;
          }
          attachedTabs.add(tabId);
          owned = false; // 复用既有附加 → 结束后不代为分离
        }
        for (const p of msg.points || []) {
          const base = { x: Math.round(p.x), y: Math.round(p.y), pointerType: 'mouse' };
          // 完整鼠标序列：移动 → 按下 → 松开（渲染层据此合成 trusted click）
          await dispatchMouse(debuggee, { ...base, type: 'mouseMoved', button: 'none' });
          await dispatchMouse(debuggee, { ...base, type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1 });
          await sleep(60); // 按下与松开间隔，模拟真实点击节奏
          await dispatchMouse(debuggee, { ...base, type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1 });
          await sleep(150); // 相邻点间隔，给前端状态同步留时间
        }
        setBadge(tabId, 'OK', '#16a34a'); // 绿色 OK = CDP 点击全部成功
        sendResponse({ ok: true });
      } catch (e) {
        setBadge(tabId, 'X', '#dc2626'); // 红色 X = attach 失败（常见原因：该页开着 F12）
        sendResponse({ ok: false, error: String(e && e.message || e) });
      } finally {
        if (owned) {
          // 只分离"自己附加"的会话；主流程的附加由 content.js 发 cdpDetach 分离，
          // 保证选项→提交→反馈层整个过程中页面布局不再因附加/分离而位移
          await detachDebugger(debuggee);
          attachedTabs.delete(tabId);
        }
      }
    })();
    return true; // 关键：声明将异步调用 sendResponse，防止消息通道提前关闭
  }

  // ---- 阶段 3：分离调试器（提示条随之消失） ----
  if (msg.type === 'cdpDetach') {
    (async () => {
      await detachDebugger(debuggee); // 未附加时调用也安全（内部忽略错误）
      attachedTabs.delete(tabId);
      sendResponse({ ok: true });
    })();
    return true;
  }

  // ---- 辅助：把"恢复视频"广播到来源标签页的所有框架 ----
  // 播放器可能在 iframe 内（content script all_frames:true），顶层框架无法
  // 直接操作跨域 iframe 的 video，因此用 tabs.sendMessage 转发到该标签页
  // 所有框架，各框架的 content script 各自恢复本地 video。
  if (msg.type === 'resumeVideo') {
    // 无 "tabs" 权限也能用 tabs.sendMessage（按 tabId 定向投递即可）
    chrome.tabs.sendMessage(tabId, { type: 'resumeVideoAll' }, () => {
      void chrome.runtime.lastError; // 无接收端（页面刷新中）等情况忽略
    });
    sendResponse({ ok: true });
    return;
  }

  // ---- v1.2.4：把"视频播完"转发为"切换下一节"广播 ----
  // 视频可能在 iframe 内（播完信号由该框架的 content script 发出），
  // 而章节侧边栏在顶层文档，因此广播到该标签页所有框架，
  // 仅顶层框架的 content script 会执行切换逻辑（非顶层直接忽略）。
  if (msg.type === 'videoEnded') {
    chrome.tabs.sendMessage(tabId, { type: 'navigateNext' }, () => {
      void chrome.runtime.lastError; // 无接收端（页面刷新中）等情况忽略
    });
    sendResponse({ ok: true });
    return;
  }

  // ---- v1.2.9：视频探测广播 ----
  // 顶层框架发起（区分"点进了有视频的播放页"还是"无视频的目录层大节"）：
  // 广播 videoProbeRun 到本标签页所有框架，各框架自查本地 <video> 后
  // 以 videoProbeResult 独立回报。
  if (msg.type === 'videoProbe') {
    chrome.tabs.sendMessage(tabId, { type: 'videoProbeRun' }, () => {
      void chrome.runtime.lastError; // 无接收端（页面刷新中）等情况忽略
    });
    sendResponse({ ok: true });
    return;
  }

  // ---- v1.2.9：视频探测报告转发 ----
  // 某框架的自查结果 → 定向转发给顶层框架（frameId 0）收集，
  // 顶层收集到任一框架"有视频"即判定切换目标有效。
  if (msg.type === 'videoProbeResult') {
    chrome.tabs.sendMessage(tabId, { type: 'videoProbeResult', hasVideo: !!msg.hasVideo },
      { frameId: 0 }, () => {
        void chrome.runtime.lastError; // 顶层刷新中等情况忽略
      });
    sendResponse({ ok: true });
    return;
  }
});
