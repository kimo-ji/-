/* ======================================================================
 * content.js —— 智慧树 AI随堂练习 自动作答（Manifest V3 content script）
 * ----------------------------------------------------------------------
 * 工作流程：
 *   1. 启动时读取 chrome.storage.local 的"启用自动作答"开关（默认开启）。
 *   2. 用 MutationObserver + 定时轮询双保险监听 DOM 变化。
 *   3. 每次变化后调用 detectPopup() 按文字特征寻找目标弹窗。
 *   4. 命中后按题型作答（单选点 A，多选全点），等待 400ms 再点"提交作答"。
 *   5. 5 秒内同一个弹窗不重复处理（去重）。
 *   6. 关闭开关时停止监听，不做任何操作。
 *   7. 作答完成后恢复被弹窗暂停的视频（并向 iframe 内播放器广播恢复指令）。
 *   8. 视频播放到结尾后自动切换下一节；若本章最后一节则进入下一章第一节（v1.2.4）。
 * 全程通过 console.log（前缀 [zhihuishu-auto]）输出诊断信息。
 * ====================================================================== */

(() => {
  'use strict';

  const TAG = '[zhihuishu-auto]'; // 日志前缀，便于在控制台筛选

  // ---------- 用户开关状态 ----------
  let enabled = true;            // 是否启用自动作答，启动时从 storage 读取
  let observer = null;           // MutationObserver 实例
  let pollTimer = null;          // 定时轮询兜底计时器
  let lastSignature = '';        // 上次处理过的弹窗文字签名（用于去重）
  let lastProcessTime = 0;       // 上次处理时间戳（ms）
  let processing = false;        // 是否正在处理某个弹窗（避免并发）
  let cooldownUntil = 0;          // 提交后冷却到期时间：此期间不再检测，防重复点击死循环
  const processedContainers = new WeakSet(); // 已处理过的弹窗容器（同一元素只处理一次）
  const DEDUP_INTERVAL = 5000;   // 去重时间窗口：5 秒
  const SELECT_DELAY = 400;      // 选中选项后等待前端状态同步的时间（ms）
  const POLL_INTERVAL = 1500;    // 定时轮询间隔（兜底，弥补 observer 可能漏掉的情况）
  const COOLDOWN = 3000;          // 提交后冷却时长（ms）

  // ---------- 自动切换下一节状态（v1.2.4 新增） ----------
  let navCooldownUntil = 0;       // 自动切换冷却到期时间：仅约束 videoEndPoll 重新扫描（不约束 navigateNext 处理器）
  // v1.2.11：已点击过的切换目标（元素 WeakSet）。定位信号（侧边栏高亮/主区域
  // 标题/URL）在点进无视频导览页后全部不更新，会导致每轮定位回同一小节、
  // 反复点同一目标死循环；防重复是唯一不依赖任何信号的破环手段：
  // 已点过的目标跳过，自动改点再下一个，直到点进有视频的页面
  // v1.2.13：改为 let，导航成功后会重置为空 WeakSet（见 goToNextLesson）。
  // clickedTargets 仅用于"单次 goToNextLesson 调用内"的死循环破除（点进大节/
  // 导览页后跳过已试过的目标）；一旦导航成功到达有视频的页面，上一轮试过的目标
  // 不再有意义，必须清空，否则下一次视频播完时这些目标会被永久跳过
  // （实测：第一次导航点过 1.2.1，成功后未清空，第二次导航直接跳过 1.2.1 跳到 1.2.2）。
  let clickedTargets = new WeakSet();
  let navClickAttempted = false; // 本轮切换流程中是否已发出过真实/合成点击（v1.2.12）
  // 用途：SPA 页签名验证不可靠（点进导览页三信号全不变），"验证失败"不等于
  // "没点过去"。区分"发出了点击但验证未确认"（继续探测/下一轮）与
  // "根本没发出点击"（两种策略都失败，退出），避免误报失败中断流程
  let navInProgress = false;      // 切换流程进行中标记：防止多个框架同时触发切换导致重复点击
  let videoPollTimer = null;      // 视频播完监视轮询计时器
  const pendingEndVideos = new WeakSet(); // 已进入"播完确认"流程的 video（防同一视频重复触发）
  // 章节标题特征："第一章/第2讲/第三单元/第Ⅳ模块"（不含"节"：小节标题常以"第X节"开头）
  const CHAPTER_RE = /^第\s*[一二三四五六七八九十百千零〇两\d]+\s*(章|讲|单元|模块)/;
  // 垃圾叶子文本：时长(12:34)、百分比、纯数字、状态词、非视频条目（测试/资料等），
  // 这些不应被当作"小节标题"（避免自动切入测试页或误点导航文字）
  const JUNK_RE = /^(\d{1,2}:\d{2}(:\d{2})?|\d+([.,]\d+)?%?|已完成|未完成|未开始|学习中|已学完|免费|试看|随堂练习|单元测试|章节测试|测验|作业|考试|资料|讨论|公告|笔记|课件|直播|回放)$/;
  // "当前正在学习的小节" class 特征词（整词匹配，避免 icon/button 之类误伤）
  const ACTIVE_RE = /^(active|actived|current|cur|selected|on|checked|playing|highlight(ed)?|focus(ed)?)$/i;

  // 【修改位置：启动日志】加上版本号——用于一眼确认页面里跑的是哪个版本的
  // 脚本（本次跨章排查发现浏览器缓存了旧版脚本，日志行号与源码对不上）
  console.log(TAG, 'content script v1.2.13 已加载，所在地址：', location.href);

  // ---------- 注入 isTrusted 覆盖到页面上下文(MAIN world) ----------
  // 用 <script src="chrome-extension://.../inject.js"> 加载扩展自己的外部脚本。
  // 关键点：
  //   - 浏览器加载页面中的 <script src> 时，代码始终在页面主世界(MAIN world)执行；
  //   - 内联脚本(textContent)会被页面 CSP 的 unsafe-inline 拦截，
  //     但 chrome-extension:// 下的外部文件不受此限制（已在 manifest 的
  //     web_accessible_resources 中声明）；
  //   - 不能用 manifest 的 world:"MAIN"：旧版 Edge 会忽略该配置，
  //     inject.js 落入隔离世界，虽然共享 DOM 能写标记造成"已注入"假象，
  //     但 Event.prototype 的覆盖对页面无效（isTrusted 仍为 false）。
  // 智慧树弹窗选项的点击处理器检查 event.isTrusted，拒绝合成事件，
  // 覆盖为 true 后 .click()/dispatchEvent 派发的事件能通过校验。
  (function injectIsTrustedOverride() {
    if (document.documentElement.dataset.zhihuishuInjected === '1') return; // 已注入则不重复
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('inject.js'); // 外部文件，绕过 CSP unsafe-inline
    script.onload = function () { this.remove(); }; // 执行完移除标签，避免残留
    script.onerror = function () {
      console.warn(TAG, 'inject.js 外部脚本加载失败（检查 web_accessible_resources 声明）');
    };
    (document.head || document.documentElement).appendChild(script);
  })();

  /**
   * waitForInjection —— 已废弃：页面 CSP 拦截所有注入（内联被 unsafe-inline 拦，
   * 外部 chrome-extension:// 脚本也被 script-src 白名单拦），isTrusted 覆盖方案
   * 整体放弃。现改用 background.js 的 chrome.debugger CDP 真实点击，
   * 事件由渲染层生成、isTrusted 天生为 true，无需任何页面注入。
   */

  // ---------- 工具函数 ----------

  /**
   * 判断元素是否"可见"。
   * 用 getClientRects 尺寸 + offsetParent + visibility 综合判断。
   */
  function isVisible(el) {
    if (!el || !el.getClientRects) return false;
    const rects = el.getClientRects();
    if (rects.length === 0) return false;
    const rect = rects[0];
    if (rect.width === 0 || rect.height === 0) return false;
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') {
      return false;
    }
    if (getComputedStyle(el).visibility === 'hidden') return false;
    return true;
  }

  /**
   * 在 root 子树中查找"自身文字包含 keyword"的元素，返回数组。
   * 用 TreeWalker 遍历，按文字特征宽松匹配，不依赖 class 名。
   */
  function findElementsByText(root, keyword) {
    const result = [];
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT,
      null
    );
    while (walker.nextNode()) {
      const el = walker.currentNode;
      const text = (el.textContent || '').trim();
      if (text.includes(keyword)) result.push(el);
    }
    return result;
  }

  /**
   * 在所有"包含 keyword 的可见元素"中，取文字最短的那个。
   * 原理：按钮自身文字最短（如恰好"提交作答"），
   *       外层容器文字最长，最短的即最精确的目标。
   */
  function findInnermostVisibleByText(root, keyword) {
    const matches = findElementsByText(root, keyword).filter(isVisible);
    if (matches.length === 0) return null;
    matches.sort(
      (a, b) =>
        (a.textContent || '').trim().length - (b.textContent || '').trim().length
    );
    return matches[0];
  }

  /**
   * fireClick —— 健壮的点击：先 .click()，再派发真实 MouseEvent。
   * 部分前端框架（Vue/React）只认真实事件，.click() 合成事件可能无效，
   * 因此补充 pointer/mouse 事件序列，bubbles 冒泡到父级监听器。
   */
  function fireClick(el) {
    if (!el) return;
    try { el.click(); } catch (e) { /* 忽略 */ }
    // 关键：派发事件必须带真实坐标（元素中心），否则用坐标做命中检测的
    // 处理器（elementFromPoint / 指针位置判断）会把零坐标事件当无效直接忽略。
    const rect = (el.getClientRects && el.getClientRects()[0]) || el.getBoundingClientRect();
    const x = rect ? rect.left + rect.width / 2 : 0;
    const y = rect ? rect.top + rect.height / 2 : 0;
    const baseOpts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: 1 };
    try {
      el.dispatchEvent(new PointerEvent('pointerover', baseOpts));
      el.dispatchEvent(new PointerEvent('pointerenter', baseOpts));
      el.dispatchEvent(new PointerEvent('pointerdown', baseOpts));
      el.dispatchEvent(new MouseEvent('mousedown', baseOpts));
      el.dispatchEvent(new PointerEvent('pointerup', baseOpts));
      el.dispatchEvent(new MouseEvent('mouseup', baseOpts));
      el.dispatchEvent(new MouseEvent('click', baseOpts));
    } catch (e) { /* 旧环境降级：上面 .click() 已兜底 */ }
  }

  // ---------- 弹窗识别 ----------

  /**
   * detectPopup —— 核心识别函数。
   * 按文字特征寻找"AI随堂练习"弹窗，不写死 CSS 选择器。
   * 判定条件（全部满足）：
   *   1. 存在可见的"提交作答"按钮；
   *   2. 从该按钮向上能找到一个包含"AI随堂练习"文字的祖先（即模态容器）；
   *   3. 容器内出现 [单选题]/[多选题] 标签或 A/B/C/D 选项。
   * 返回：{ container, submitBtn, type } 或 null。
   */
  function detectPopup() {
    // 1) 找"提交作答"按钮（最精确的锚点）
    const submitBtn = findInnermostVisibleByText(document.body, '提交作答');
    if (!submitBtn) return null;

    // 2) 从按钮向上找包含"AI随堂练习"文字的祖先 → 模态容器
    let container = null;
    let node = submitBtn.parentElement;
    while (node && node !== document.body) {
      if ((node.textContent || '').includes('AI随堂练习')) {
        container = node;
        break;
      }
      node = node.parentElement;
    }
    if (!container || !isVisible(container)) {
      console.log(TAG, '找到提交按钮但未定位到含"AI随堂练习"的容器');
      return null;
    }

    // 3) 判定题型：去掉所有半角/全角方括号与空白后按"单选题/多选题"关键词识别
    //    兼容 [单选题] ［单选题］ 以及无括号"单选题"三种写法
    const containerText = (container.textContent || '')
      .replace(/\s+/g, '')
      .replace(/[［\[\]］]/g, '');
    let type = 'unknown';
    if (containerText.includes('单选题')) {
      type = 'single';
    } else if (containerText.includes('多选题')) {
      type = 'multiple';
    }

    // 4) 若没有题型标签，再退一步用 A/B/C/D 选项字母推断
    if (type === 'unknown') {
      const options = findOptionRows(container);
      if (options.length > 0) {
        type = 'single'; // 有字母选项但无题型标签，默认按单选处理
      } else {
        console.log(TAG, '弹窗已识别但非单选/多选，跳过');
        return null; // 填空/简答/判断等 → 不处理
      }
    }

    return { container, submitBtn, type };
  }

  /**
   * findOptionRows —— 在弹窗容器内查找选项行（双策略）。
   * 策略一：找"文字恰好为单个字母 A-D"的元素（字母单独成元素，如圆形徽章），
   *         再向上爬到含字母+答案文字的"选项行"。
   * 策略二（策略一无果时）：找"文字以字母 A-D 开头且带分隔"的元素
   *         （字母与答案在同一元素内，如 "A 选项内容"）。
   * 返回：[{ letter, rowEl }] 按字母排序。
   */
  function findOptionRows(container) {
    // ---- 策略一：字母单独成元素 ----
    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_ELEMENT,
      null
    );
    const letterEls = [];
    while (walker.nextNode()) {
      const el = walker.currentNode;
      const text = (el.textContent || '').trim();
      // 必须可见：隐藏模板/下拉里也可能存在孤立字母元素（不可见、rect 为 0），
      // 选中它会导致 CDP 点击坐标算到 (0,0) 附近而点空
      if (/^[A-D]$/.test(text) && isVisible(el)) {
        letterEls.push(el);
      }
    }

    if (letterEls.length > 0) {
      // 去重：同一字母可能被嵌套元素重复命中，保留最深的那个（叶子标签）
      const byLetter = {};
      for (const el of letterEls) {
        const L = el.textContent.trim();
        if (!(L in byLetter)) {
          byLetter[L] = el;                 // 首次记录
        } else if (byLetter[L].contains(el)) {
          byLetter[L] = el;                 // el 是已记录元素的后代 → 更深，替换
        }
      }
      const rows = [];
      for (const L of Object.keys(byLetter).sort()) {
        // 同时保留字母徽章元素(letterEl)与选项行(rowEl)：
        // 点击叶子徽章会向上冒泡，能命中挂在徽章/中间层/行任一层上的处理器
        rows.push({ letter: L, letterEl: byLetter[L], rowEl: findOptionRow(byLetter[L]) });
      }
      if (rows.length > 0) return rows;
    }

    // ---- 策略二：字母与答案在同一元素内（文字以 A-D + 分隔开头） ----
    const rowEls = [];
    const walker2 = document.createTreeWalker(
      container,
      NodeFilter.SHOW_ELEMENT,
      null
    );
    const seen = new Set();
    while (walker2.nextNode()) {
      const el = walker2.currentNode;
      const text = (el.textContent || '').trim();
      // 匹配 "A 选项内容" / "A.选项" / "A、选项" 等；排除过短或过长容器
      const m = text.match(/^([A-D])\s*[.、．\s]/);
      if (m && text.length >= 3 && text.length < 500 && isVisible(el)) {
        // 取最深的（叶子侧）匹配，避免选中包含多个选项的外层容器
        if (seen.has(el)) continue;
        // 若该元素的子元素也有同样匹配，则跳过当前（留更深的）
        let hasDeeper = false;
        for (const child of el.querySelectorAll('*')) {
          if (/^([A-D])\s*[.、．\s]/.test((child.textContent || '').trim())) {
            hasDeeper = true;
            break;
          }
        }
        if (hasDeeper) continue;
        rowEls.push({ letter: m[1], letterEl: el, rowEl: el });
        seen.add(el);
      }
    }
    // 按字母排序去重
    const map = {};
    for (const r of rowEls) {
      if (!(r.letter in map)) map[r.letter] = r;
    }
    return Object.keys(map).sort().map((L) => map[L]);
  }

  /**
   * findOptionRow —— 从字母标签向上爬，找到"选项行"元素。
   * 选项行 = 其文字长度 > 1（既含字母又含答案内容）的最近祖先。
   * 最多向上爬 6 层，找不到则回退为字母标签本身（事件会冒泡）。
   */
  function findOptionRow(letterEl) {
    let el = letterEl;
    for (let i = 0; i < 6; i++) {
      el = el.parentElement;
      if (!el) break;
      const text = (el.textContent || '').trim();
      if (text.length > 1) return el; // 含字母 + 答案文字 → 这就是选项行
    }
    return letterEl; // 回退：直接点击字母标签
  }

  // ---------- 作答动作 ----------

  /**
   * centerOf —— 元素中心点坐标（视口 CSS 像素，与 CDP Input 坐标系一致）。
   */
  function centerOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  /**
   * pickPointFor —— 为一个选项挑选"最可能被真实点击命中"的坐标点。
   * 依次尝试：字母徽章 → 选项行。每个候选都要过三关：
   *   1) 可见；2) 尺寸非零；3) elementFromPoint 命中自己/后代/行内元素
   *      （真实鼠标点击的命中检测与此完全一致，等于提前验证坐标不会点空）。
   * 全部失败则兜底取行中心；行也不可见时返回 null（放弃该选项）。
   */
  function pickPointFor(r) {
    const cands = [r.letterEl, r.rowEl].filter(Boolean);
    for (const el of cands) {
      if (!isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const p = centerOf(el);
      const hit = document.elementFromPoint(p.x, p.y);
      // 命中目标自身、其后代、或行内任意元素都算有效（事件会冒泡到行处理器）
      if (hit && (el.contains(hit) || hit.contains(el) || (r.rowEl && r.rowEl.contains(hit)))) {
        return { point: p, by: el === r.letterEl ? '字母徽章' : '选项行' };
      }
    }
    if (r.rowEl && isVisible(r.rowEl)) {
      return { point: centerOf(r.rowEl), by: '行中心兜底' };
    }
    return null;
  }

  /**
   * debugMark —— 诊断辅助：在即将点击的坐标处画红色标记点，3 秒后自动消失。
   * 标记带 pointer-events:none，对真实点击完全透明，不会挡住 CDP 点击。
   * 用户无需开 F12，肉眼即可确认点击坐标是否落在选项圆圈上。
   */
  function debugMark(points) {
    for (const p of points) {
      const dot = document.createElement('div');
      dot.style.cssText =
        'position:fixed;left:' + (p.x - 5) + 'px;top:' + (p.y - 5) + 'px;' +
        'width:10px;height:10px;border-radius:50%;background:red;' +
        'border:2px solid white;box-shadow:0 0 4px rgba(0,0,0,.5);' +
        'z-index:2147483647;pointer-events:none;';
      document.body.appendChild(dot);
      setTimeout(() => dot.remove(), 3000);
    }
  }

  /**
   * realClicks —— 请求 background.js 通过 chrome.debugger 派发"真实点击"。
   * 渲染层生成的输入事件 isTrusted=true，与用户手点无法区分，
   * 可通过页面所有的 isTrusted 校验。
   * 返回 true = 全部点击派发成功；false = 失败（如该标签页开着 F12），
   * 调用方应回退合成事件路径。
   */
  function realClicks(points) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'cdpClicks', points }, (res) => {
          if (chrome.runtime.lastError) {
            console.warn(TAG, 'CDP 消息失败：', chrome.runtime.lastError.message);
            resolve(false);
            return;
          }
          if (res && res.ok) {
            resolve(true);
            return;
          }
          console.warn(TAG, 'CDP 真实点击失败：', res && res.error);
          resolve(false);
        });
      } catch (e) {
        console.warn(TAG, 'CDP 消息异常：', e);
        resolve(false);
      }
    });
  }

  // ---------- CDP 两阶段时序辅助（v1.2.2 新增） ----------

  /** sleep —— 简单延时工具（Promise 化 setTimeout）。 */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * cdpAttach —— 请求 background 先行附加调试器（只附加、不点击）。
   * 附加动作会触发浏览器顶部"已开始调试"提示条并使页面布局位移，
   * 必须让这次位移发生在"量坐标"之前，否则量好的坐标点击时已经对不上。
   * 返回 true = 附加成功；false = 失败（如该页开着 F12），调用方走回退。
   */
  function cdpAttach() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'cdpAttach' }, (res) => {
          if (chrome.runtime.lastError) {
            console.warn(TAG, 'cdpAttach 消息失败：', chrome.runtime.lastError.message);
            resolve(false);
            return;
          }
          resolve(!!(res && res.ok));
        });
      } catch (e) {
        console.warn(TAG, 'cdpAttach 异常：', e);
        resolve(false);
      }
    });
  }

  /**
   * cdpDetach —— 作答流程结束后分离调试器，顶部提示条随之消失。
   */
  function cdpDetach() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'cdpDetach' }, () => {
          void chrome.runtime.lastError; // 忽略（如 SW 已休眠），分离尽力而为
          resolve(true);
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  /**
   * waitForRectStable —— 等待元素矩形"真正静止"再继续。
   * 每 80ms 采样一次 getBoundingClientRect，连续两次完全一致视为静止。
   * 比旧版固定延时（350ms）更可靠：无论入场动画是 300ms 还是 500ms、
   * 是 scale 还是 translate、或字体加载引起回流，都以"实测不动"为准，
   * 避免动画中途量坐标导致点击点偏移（v1.2.1 实测红点整体偏左下）。
   * 超时（默认 2.5s）按当前位置继续，不无限等待。
   */
  async function waitForRectStable(el, timeout = 2500) {
    const key = () => {
      const r = el.getBoundingClientRect();
      // 取整后拼串比较：忽略亚像素抖动，只关注整像素级位移
      return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
    };
    const start = Date.now();
    let last = key();
    while (Date.now() - start < timeout) {
      await sleep(80); // 采样间隔
      const cur = key();
      if (cur === last) return true; // 连续两次一致 → 布局已静止
      last = cur;
    }
    console.warn(TAG, '等待弹窗位置稳定超时，按当前位置继续');
    return false;
  }

  /**
   * clickOption —— 健壮地选中一个选项，两步：
   * 1) 若行内有真实 <input type=radio/checkbox>：置 checked=true 并派发
   *    change/input（Vue v-model 监听这俩、且不查 isTrusted，能绕开反作弊）；
   * 2) 点字母徽章元素（事件向上冒泡，命中挂在徽章/行/祖先任一层上的处理器）。
   *
   * 注意：只点一次！之前同时点 letterEl 和 rowEl 会导致多选题（checkbox）
   *       被反复切换——点一次选中、再点一次取消，净效果为零。
   *       inject.js 已覆盖 isTrusted，合成事件能通过校验，无需多点兜底。
   */
  function clickOption(r) {
    // 1) 真实 input 控件兜底
    const inputs = r.rowEl.querySelectorAll('input[type="radio"],input[type="checkbox"]');
    for (const inp of inputs) {
      if (!inp.checked) {
        inp.checked = true;
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    // 2) 点击选项：优先点字母徽章（事件冒泡到选项行处理器），无徽章则点行本身
    //    只点一次，避免多选题反复切换选中状态
    fireClick(r.letterEl || r.rowEl);
  }

  // （旧 answerSingleChoice / answerMultipleChoice / submit 已合并进 handlePopup：
  //   现以 CDP 真实点击为主路径，合成事件 fireClick/clickOption 仅作回退）

  /**
   * dismissFeedback —— 提交后处理反馈层。
   * 智慧树提交后会显示"回答正确/错误"等反馈，需点确认按钮（"知道了/继续/完成"
   * 等）才会关闭弹窗、让视频恢复播放。
   * 反馈层可能在原容器内，也可能是一个新弹窗（在容器之外），因此分两步：
   *   1) 先在原容器范围内找反馈按钮；
   *   2) 再在全文档找"结果弹窗"（含 回答正确/错误/解析/完成作答 等关键词），
   *      在其内部找反馈按钮。这样既覆盖新弹窗，又避免点到页面无关导航按钮。
   */
  const FEEDBACK_TEXTS = [
    '知道了', '确定', '完成', '继续', '继续观看', '继续播放',
    '下一题', '下一道', '关闭', '确认', '查看解析', 'OK', '好的',
  ];
  const RESULT_KEYWORDS = [
    '回答正确', '回答错误', '答对', '答错', '正确答案',
    '解析', '完成作答', '已提交', '提交成功',
  ];
  // 在某元素子树内找最精确的反馈按钮（文字恰好等于反馈词、可见、最短）
  function findFeedbackBtnIn(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    let best = null;
    while (walker.nextNode()) {
      const el = walker.currentNode;
      const t = (el.textContent || '').trim();
      if (t.length > 0 && t.length <= 6 && FEEDBACK_TEXTS.includes(t) && isVisible(el)) {
        if (!best || t.length < (best.textContent || '').trim().length) best = el;
      }
    }
    return best;
  }
  // 全文档找"结果弹窗"：含任一结果关键词、且为 fixed/absolute 定位（弹窗/遮罩层）
  // 的最小可见元素。限制 position 避免匹配到侧边栏、课程导航等无关内容。
  function findResultModal() {
    const all = [...document.querySelectorAll('*')].filter((el) => {
      if (!isVisible(el)) return false;
      const style = getComputedStyle(el);
      // 弹窗/对话框通常是 fixed 或 absolute 定位
      if (style.position !== 'fixed' && style.position !== 'absolute') return false;
      const t = (el.textContent || '').replace(/\s+/g, '');
      if (!t || t.length > 500) return false; // 排除超大容器（如整个侧边栏）
      return RESULT_KEYWORDS.some((k) => t.includes(k));
    });
    if (all.length === 0) return null;
    // 取文字最短的（最精确的结果容器）
    all.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    return all[0];
  }
  async function dismissFeedback(container) {
    const tries = 8;        // 最多尝试 8 次
    const interval = 450;   // 每次间隔 450ms，共约 3.6s
    for (let i = 0; i < tries; i++) {
      await new Promise((r) => setTimeout(r, interval));
      // 1) 原容器范围内找反馈按钮
      let found = findFeedbackBtnIn(container);
      // 2) 没找到则找 fixed/absolute 定位的结果弹窗，在其中找反馈按钮
      if (!found) {
        const resultModal = findResultModal();
        if (resultModal) {
          found = findFeedbackBtnIn(resultModal);
        }
      }
      if (found) {
        console.log(TAG, '点击反馈按钮：', (found.textContent || '').trim());
        const ok = await realClicks([centerOf(found)]); // CDP 真实点击优先
        if (!ok) fireClick(found); // 失败回退合成事件
        return; // 点掉反馈层，结束
      }
      // 反馈层未出现：可能提交后弹窗直接关闭了
    }
    console.log(TAG, '未发现反馈层（可能已自动关闭）');
  }

  /**
   * resumeVideo —— 恢复被弹窗暂停的视频（v1.2.3 新增）。
   * 弹窗/反馈层关闭后，部分版本播放器不会自动续播，这里补一刀：
   * 对"播放过（currentTime>0）、未播完（未 ended）、处于暂停"的 video 调
   * play()。play() 是播放器原生 API，不涉及 isTrusted 校验；
   * 用户此前与页面有过交互（点过播放），一般不会被自动播放策略拦截。
   * 仅在顶层框架才做 CDP 真实点击回退：CDP Input 用的是顶层视口坐标，
   * iframe 内的坐标体系不同，点过去会错位，故 iframe 中只尝试 play()。
   */
  async function resumeVideo() {
    const isTop = window.self === window.top; // 是否顶层框架
    const videos = [...document.querySelectorAll('video')];
    for (const v of videos) {
      if (!v.paused || v.ended) continue;                      // 在播/已播完的跳过
      if (!(v.currentTime > 0) || !(v.duration > 0)) continue; // 从未播放过的跳过
      try {
        await v.play();
        console.log(TAG, '已恢复视频播放（play() 成功）');
      } catch (e) {
        console.warn(TAG, 'play() 被拒绝：', e && e.message);
        // 顶层框架回退：对视频中心做一次 CDP 真实点击（等价用户手点恢复）
        if (isTop) {
          const r = v.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            const ok = await realClicks([
              { x: r.left + r.width / 2, y: r.top + r.height / 2 },
            ]);
            console.log(TAG, ok
              ? 'CDP 点击视频中心完成（回退恢复播放）'
              : 'CDP 回退点击失败（该页若开着 F12 请关闭）');
          }
        }
      }
    }
  }

  /**
   * broadcastResumeVideo —— 通知同标签页"所有框架"的 content script 恢复视频。
   * 播放器可能嵌在 iframe 里（manifest all_frames:true，每个框架都有本脚本），
   * 顶层框架无法直接访问跨域 iframe 的 DOM，因此借道 background 用
   * chrome.tabs.sendMessage 把恢复指令广播到该标签页的所有框架。
   */
  function broadcastResumeVideo() {
    try {
      chrome.runtime.sendMessage({ type: 'resumeVideo' }, () => {
        void chrome.runtime.lastError; // 无接收方等情况忽略
      });
    } catch (e) { /* 忽略广播失败 */ }
  }

  // ======================================================================
  // 视频播完自动切换下一节（v1.2.4 新增）
  // ----------------------------------------------------------------------
  // 需求：小节视频播放到结尾后自动进入下一节；若当前是本章最后一节，
  //       自动进入下一章的第一节。
  // 思路：
  //   - 每个 content script（含 iframe 内）各自监视本地 <video>，轮询发现
  //     播完（ended 或进度距结尾 <0.3s）后等 4 秒复核：播放器对小节内
  //     多段视频会自动连播（4 秒后恢复播放）→ 取消；仍处于播完暂停 → 确认；
  //   - 确认后经 background 把 navigateNext 广播到本标签页所有框架，
  //     由顶层框架执行切换（章节侧边栏在顶层文档；播放器可能在 iframe，
  //     顶层拿不到其内部 DOM，所以"找下一节按钮"失败时走侧边栏方案）；
  //   - 顶层框架两层策略（依次尝试，每次点击后用页面信号验证是否真切换了）：
  //     策略一：解析左侧章节树 —— 收集"第X章/讲/单元"标题与小节标题叶子，
  //             用 class 中 active/current 等标记定位当前小节，
  //             点文档序中的下一个小节；当前是最后一节时，
  //             先点下一章标题展开，再点它下面的第一节；
  //     策略二：找"下一节"文字按钮直接点击（排除"自动进入下一节"等设置项）。
  //   - 点击统一走 cdpClickElement：滚动到视口 → 附加调试器（提示条会让
  //     页面位移，必须先附加再量坐标）→ 等矩形静止 → 量中心 → CDP 真实
  //     点击 → 分离（复用 v1.2.2 验证过的可靠时序）；CDP 失败（如开着
  //     F12）回退合成点击（导航类操作一般不校验 isTrusted）。
  // ======================================================================

  /**
   * collectTextLeaves —— 收集 root 子树内"带直接文本"的叶子元素。
   * 叶子 = 拥有非空白"直接文本子节点"（nodeType=3）的元素，返回 [{el, text}]。
   * 性能关键（v1.2.6 教训）：绝不逐元素取 textContent —— 它会把整个子树
   * 序列化成大字符串，几万个元素就是几万次全子树拼接，页面直接卡死。
   * 这里只拼接元素自己的直接文本节点，成本与子树大小无关。
   */
  function collectTextLeaves(root) {
    const leaves = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    let node;
    while ((node = walker.nextNode())) {
      const el = node;
      let text = '';
      for (const c of el.childNodes) {
        if (c.nodeType === Node.TEXT_NODE && c.nodeValue) text += c.nodeValue;
      }
      text = text.trim();
      if (text) leaves.push({ el, text });
    }
    return leaves;
  }

  /**
   * collectSidebar —— 解析左侧章节树（纯文字特征，不写死 class）。
   * 返回 { headers, lessons }：
   *   headers —— 章级标题叶子（"第X章/讲/单元…"），文档序；
   *   lessons —— 小节标题叶子（非章标题、非时长/状态词垃圾文本），文档序。
   * 章节树按文档序渲染，因此 lessons 的文档序即学习顺序。
   * 章级标题被排除在小节之外还有个好处：章末的"第X章测试"等以
   * "第X章"开头的条目会被自动跳过，不会误入测试页。
   */
  function collectSidebar(quiet) { // quiet=true 时静默解析（验证环节复用，避免刷屏）
    const W = window.innerWidth;
    // 两阶段过滤，避免大页面布局抖动冻结（v1.2.5 卡死根因）：
    //   第一阶段：纯文字过滤（零布局调用）——先把几千个叶子缩到几十个候选；
    //   第二阶段：才做可见性/位置检查（isVisible / getBoundingClientRect）。
    // 旧版对每个叶子直接 isVisible：视频页持续有动画 → DOM 一直"脏"，
    // 每次布局读取都强制整页重排，几千个叶子 × 整页重排 = 冻结几十秒，
    // 表现为"开始尝试切换下一节"之后再无任何日志。
    const leaves = collectTextLeaves(document.body);
    const headers = leaves
      .filter((r) => r.text.length > 1 && r.text.length <= 40 && CHAPTER_RE.test(r.text))
      .filter((r) => isVisible(r.el) && r.el.getBoundingClientRect().left < W * 0.45)
      .map((r) => r.el);
    // v1.2.11：侧边栏右边界收紧为 min(窗口30%, 400px)。旧值 W*0.45 会把
    // 主区域左侧的面包屑/"AI课程导览"导航条等混进小节列表（实测导致点击
    // 目标错乱）；章节侧边栏实际宽度远小于窗口的 45%
    const sidebarMaxX = Math.min(W * 0.3, 400);
    let lessons = leaves
      .filter((r) => r.text.length >= 4 && r.text.length <= 80
        && !CHAPTER_RE.test(r.text) && !JUNK_RE.test(r.text))
      .filter((r) => isVisible(r.el) && r.el.getBoundingClientRect().left < sidebarMaxX)
      .map((r) => r.el);
    // 同一行的多个叶子（如"序号 1.1.1"+"标题"分离渲染）合并为一个条目：
    // 视觉同行（top 差 <15px）保留文字较长者（标题优先于序号），
    // 否则文档序会把序号/标题交错当成相邻小节，导致"下一节"定位错乱
    const merged = [];
    for (const el of lessons) {
      const prev = merged[merged.length - 1];
      if (prev
        && Math.abs(prev.getBoundingClientRect().top - el.getBoundingClientRect().top) < 15) {
        if ((el.textContent || '').trim().length > (prev.textContent || '').trim().length) {
          merged[merged.length - 1] = el;
        }
      } else {
        merged.push(el);
      }
    }
    lessons = merged;
    if (headers.length > 0) {
      // 只保留纵向落在章节区（首个章标题上方 60px 以下）的小节，
      // 剔除顶栏课程名、Logo 等位于章节区之外的噪音文字
      const topMin = Math.min(...headers.map((h) => h.getBoundingClientRect().top)) - 60;
      lessons = lessons.filter((l) => l.getBoundingClientRect().top >= topMin);
    }
    if (!quiet) {
      console.log(TAG, '[自动下一节] 解析侧边栏：章标题数', headers.length,
        '，小节数', lessons.length,
        '，小节列表:', lessons.map((l) => (l.textContent || '').trim().slice(0, 18)));
    }
    return { headers, lessons };
  }

  /**
   * activeAncestor —— 元素自身或祖先的 class 是否带"当前项"特征词。
   * class 按空白拆成完整单词后整词匹配（ACTIVE_RE 带锚定），
   * 避免子串误伤（如 icon、button 里也含 on/cur 的子串）。
   * 返回 { el, token } 或 null。
   */
  function activeAncestor(el) {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      // SVG 元素的 className 是 SVGAnimatedString 对象，取 baseVal
      const raw = typeof n.className === 'string'
        ? n.className
        : (n.className && n.className.baseVal) || '';
      const tokens = raw.split(/\s+/).filter(Boolean);
      const hit = tokens.find((t) => ACTIVE_RE.test(t));
      if (hit) return { el: n, token: hit };
    }
    return null;
  }

  /**
   * findMainTitle —— 在小节叶子中找"主区域（右侧 55%）出现同名标题"的那一节。
   * 播放器上方通常显示当前小节标题；进入"X.Y"目录层大节时主区域显示大节名。
   * 性能（v1.2.5 教训）：TreeWalker 纯遍历 + 文字 Map 匹配（零布局调用），
   * 只有文字命中的极少数元素才做可见性/位置检查。返回小节元素或 null。
   * v1.2.9 起它同时服务于两处：findCurrentLesson 的第一优先定位依据、
   * navSignature 的"主区域标题"信号（SPA 切课后唯一稳定变化的信号）。
   */
  function findMainTitle(lessons) {
    const W = window.innerWidth;
    const byTitle = new Map();
    for (const el of lessons) byTitle.set((el.textContent || '').trim(), el);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null);
    let n;
    while ((n = walker.nextNode())) {
      const lesson = byTitle.get((n.textContent || '').trim());
      if (!lesson) continue; // 文字过滤（便宜），命中后才做布局检查
      if (!isVisible(n)) continue;
      if (n.getBoundingClientRect().left < W * 0.55) continue;
      return lesson;
    }
    return null;
  }

  /**
   * normalizeText —— 文本归一化：去首尾空白、合并内部空白。
   * 侧边栏同一节课可能在多个 DOM 位置渲染，文本略有差异（如 "1.2 艺术与艺术品"
   * 与 "1.2艺术与艺术品"），归一化后比较可识别为同一节课。
   */
  function normalizeText(s) {
    return (s || '').trim().replace(/\s+/g, '');
  }

  /**
   * findCurrentLesson —— 在小节叶子中定位"正在学习"的那一节。
   * v1.2.9 优先级调整（实测教训）：点进"X.Y"目录层大节后，侧边栏 active
   * 高亮仍停在原小节不更新（SPA 局部刷新），靠 class 标记定位会重复点同一
   * 目标造成死循环；主区域标题反映真实所在页，提升为第一优先。
   * 兜底：叶子（或其祖先）class 带 active/current 等标记。
   * v1.2.13 修正：当多个小节都有 active 祖先时（父大节挂 current、子小节挂
   * active），选 active 标记"离叶子最近"的那个——父大节的标记在较高层，
   * 子小节的标记在较深层，最近者才是真正正在播放的小节，避免把父大节误判
   * 为当前小节后又点到其子小节（倒回去）。
   */
  function findCurrentLesson(lessons) {
    const main = findMainTitle(lessons);
    if (main) return { leaf: main, via: '主区域标题匹配' };
    let best = null;
    let bestDepth = Infinity;
    for (const el of lessons) {
      const a = activeAncestor(el);
      if (!a) continue;
      // 计算叶子到 active 标记所在元素的距离（层数），越小越近
      let depth = 0;
      for (let n = el; n && n !== a.el; n = n.parentElement) depth++;
      if (depth < bestDepth) {
        bestDepth = depth;
        best = { leaf: el, via: 'class 标记[' + a.token + ']' };
      }
    }
    return best;
  }

  /**
   * cdpClickElement —— 自动切换的统一点击入口（CDP 真实点击优先）。
   * 时序复用 v1.2.2 的可靠经验：先滚动到视口内 → 先附加调试器（附加触发的
   * 提示条会让页面位移，必须先附加再量坐标）→ 等矩形静止 → 量中心 →
   * CDP 派发真实点击 → finally 分离调试器。
   * CDP 失败（该页开着 F12 等）回退合成点击；返回 true = 已尝试点击。
   */
  async function cdpClickElement(el, label) {
    try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* 忽略 */ }
    await sleep(200); // 等滚动与布局落定
    const attached = await cdpAttach();
    if (attached) {
      await sleep(150);
      await waitForRectStable(el); // 提示条位移/展开动画结束后再量坐标
    }
    try {
      const rect = el.getBoundingClientRect();
      const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      // 遮挡预检：真实点击按坐标做命中检测，若目标位置被弹层/遮罩盖住会点在遮挡层上
      const hit = document.elementFromPoint(point.x, point.y);
      // 记录命中元素：若与目标不一致（如命中其祖先），说明目标本身不可命中
      // （pointer-events:none 等），真实点击会落在祖先上——这是重要的诊断线索
      console.log(TAG, '[自动下一节] 点击点命中元素：',
        hit ? hit.tagName + '.' + String(typeof hit.className === 'string' ? hit.className : '').slice(0, 40) : 'null');
      if (hit && !(el.contains(hit) || hit.contains(el))) {
        console.warn(TAG, '[自动下一节] 注意：目标位置被遮挡（',
          hit.tagName + '.' + String(typeof hit.className === 'string' ? hit.className : '').slice(0, 40),
          '），真实点击可能落在遮挡层上');
      }
      if (attached) {
        const ok = await realClicks([point]);
        if (ok) {
          navClickAttempted = true; // v1.2.12：登记已发出点击（供 goToNextLesson 判断）
          console.log(TAG, '[自动下一节] CDP 真实点击完成：', label);
          return true;
        }
        console.warn(TAG, '[自动下一节] CDP 不可用，回退合成点击：', label);
      }
      fireClick(el);
      navClickAttempted = true; // v1.2.12：登记已发出点击
      console.log(TAG, '[自动下一节] 合成点击完成：', label);
      return true;
    } finally {
      if (attached) await cdpDetach();
    }
  }

  /**
   * navSignature —— 切换是否生效的判定信号（JSON 字符串，前后对比）。
   * 组合四个信号：URL、侧边栏"当前小节"高亮文字、主区域标题、是否有视频在开头段播放。
   * 点击后重新采样：任一信号变化即视为切换已生效。
   */
  function navSignature() {
    // v1.2.9 新增 main 信号：实测点进"X.Y"大节后 url（SPA 不变）、active
    // （高亮不更新）、playing（视频在跨域 iframe 顶层查不到）三者全不变，
    // 导致切换明明成功却被判失败；主区域标题是唯一稳定变化的信号
    const sig = { url: location.href, active: '', main: '', playing: false };
    try {
      const { lessons } = collectSidebar(true); // 静默解析
      for (const el of lessons) {
        if (activeAncestor(el)) { sig.active = (el.textContent || '').trim(); break; }
      }
      const main = findMainTitle(lessons);
      sig.main = main ? (main.textContent || '').trim() : '';
    } catch (e) { /* 解析失败忽略 */ }
    try {
      for (const v of document.querySelectorAll('video')) {
        if (!v.paused && v.currentTime > 0 && v.currentTime < 120) { sig.playing = true; break; }
      }
    } catch (e) { /* 忽略 */ }
    return JSON.stringify(sig);
  }

  /**
   * verifyNavChanged —— 点击后轮询验证（默认最长 6 秒、每 500ms 采样一次）。
   * SPA 页面切课可能异步拉数据后延迟更新高亮/播放器，固定等 3 秒会漏判；
   * 期间若发生整页跳转，本框架随之销毁、等待自然中断（无碍，跳转即成功）。
   * 失败时输出前后签名，便于诊断"到底什么没变"。
   */
  async function verifyNavChanged(before, waitMs) {
    const total = waitMs || 6000;
    const step = 500;
    for (let t = 0; t < total; t += step) {
      await sleep(step);
      if (navSignature() !== before) return true;
    }
    console.log(TAG, '[自动下一节] 验证失败。切换前签名：', before,
      '→ 当前签名：', navSignature());
    return false;
  }

  /**
   * rowCandidates —— 组装同一小节行的候选点击目标（按优先级）。
   * 真实点击按坐标命中：标题叶子可能 pointer-events:none 或行内另有 <a> 载体，
   * 只点标题一处可能落在"不可点"区域；依次尝试 标题 → 行内 <a> → 行容器，
   * 每次点击后都验证，命中即停。跳过 target=_blank 的链接（会新开标签页）。
   */
  function rowCandidates(leaf) {
    const row = leaf.closest('li') || leaf.parentElement;
    const link = row ? row.querySelector('a') : null;
    if (link && link.target === '_blank') {
      console.log(TAG, '[自动下一节] 注意：小节链接 target=_blank，跳过该候选（避免新开标签页）');
    }
    const cands = [leaf];
    if (link && link !== leaf && link.target !== '_blank') cands.push(link);
    if (row && row !== leaf) cands.push(row);
    return cands;
  }

  /**
   * clickUntilNavChanged —— 依次点击候选目标，每次点击后验证是否切换成功。
   * 全部候选用尽仍未变化返回 false（调用方继续下一策略）。
   */
  async function clickUntilNavChanged(cands, label, before) {
    for (const el of cands) {
      if (!el) continue;
      console.log(TAG, '[自动下一节] 点击' + label + '：', (el.textContent || '').trim().slice(0, 24),
        '<' + el.tagName + ' class=' + String(typeof el.className === 'string' ? el.className : '').slice(0, 40) + '>');
      await cdpClickElement(el, label + '「' + (el.textContent || '').trim().slice(0, 20) + '」');
      if (await verifyNavChanged(before)) {
        console.log(TAG, '[自动下一节] 页面已变化，切换成功（' + label + '）');
        return true;
      }
      console.log(TAG, '[自动下一节] 点击后页面无变化，尝试下一个候选目标');
    }
    return false;
  }

  /**
   * navViaSidebar —— 策略一：解析左侧章节树并点击下一个小节。
   * 情形 A：文档序中当前小节之后还有小节（同章下一节，或下一章已展开时的
   *         第一节）→ 直接点它；
   * 情形 B：当前是可见小节中的最后一节 → 下一章大概率折叠：先点文档序中
   *         位于其后的第一个章标题展开，等 1 秒重新解析，点该章下第一节。
   * 返回 true = 已确认切换成功；false = 未生效（调用方继续下一策略）。
   */
  async function navViaSidebar(before) {
    const { headers, lessons } = collectSidebar();
    if (lessons.length === 0) {
      console.warn(TAG, '[自动下一节] 策略一：未解析到小节标题');
      return false;
    }
    const cur = findCurrentLesson(lessons);
    if (!cur) {
      console.warn(TAG, '[自动下一节] 策略一：无法定位当前小节（无 active 标记且主区无同名标题）');
      return false;
    }
    console.log(TAG, '[自动下一节] 当前小节：', (cur.leaf.textContent || '').trim(),
      '（定位依据：' + cur.via + '）');

    // ---- 情形 A：还有下一个小节 ----
    const idx = lessons.indexOf(cur.leaf);
    const curNorm = normalizeText(cur.leaf.textContent); // 当前小节归一化文本
    if (idx >= 0 && idx < lessons.length - 1) {
      // v1.2.12：不再按缩进过滤（实测 left 差异不稳定），只按防重复跳过。
      // v1.2.13：增加"同文本跳过"——侧边栏同一节课可能在多个 DOM 位置渲染
      // （如章节标题同时出现在折叠区和展开区），WeakSet 只能防同一元素重复，
      // 无法防"不同元素但是同一节课"。归一化文本比较可识别并跳过，
      // 避免连续点同一个目标导致页面毫无变化（实测 1.2 艺术与艺术品复现此 bug）。
      let next = null;
      for (let i = idx + 1; i < lessons.length; i++) {
        if (clickedTargets.has(lessons[i])) {
          console.log(TAG, '[自动下一节] 跳过已点击过的目标：',
            (lessons[i].textContent || '').trim().slice(0, 20));
          continue;
        }
        if (normalizeText(lessons[i].textContent) === curNorm) {
          console.log(TAG, '[自动下一节] 跳过与当前小节同文本的重复条目：',
            (lessons[i].textContent || '').trim().slice(0, 20));
          continue;
        }
        next = lessons[i];
        break;
      }
      if (next) {
        clickedTargets.add(next); // 点击前登记，防止下轮重复点它
        // 依次尝试 行内多个候选载体（标题/链接/行容器），命中即停
        return await clickUntilNavChanged(rowCandidates(next), '下一个小节', before);
      }
      // 后面全部已点过 → 视同可见列表末尾，落到情形 B
    }

    // ---- 情形 B：已是可见小节中的最后一节 → 展开下一章 ----
    const nextHeader = headers.find(
      (h) => cur.leaf.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING
    );
    if (!nextHeader) {
      console.log(TAG, '[自动下一节] 已是本课程的最后一节，无需切换');
      return true; // 无需切换视为完成，避免 30 秒后反复重试
    }
    console.log(TAG, '[自动下一节] 当前是本章最后一节 → 展开下一章：',
      (nextHeader.textContent || '').trim());
    await cdpClickElement(nextHeader,
      '章标题「' + (nextHeader.textContent || '').trim().slice(0, 20) + '」（展开）');
    await sleep(1000); // 等展开动画与列表渲染

    // 展开后重新解析，点"文档序在该章标题之后"的第一个小节（下一章第一节）
    // v1.2.12：缩进过滤已移除，只保留防重复
    // v1.2.13：同情形 A，跳过与当前小节同文本的重复条目
    const again = collectSidebar();
    const first = again.lessons.find(
      (l) => (nextHeader.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING)
        && !clickedTargets.has(l)
        && normalizeText(l.textContent) !== curNorm
    );
    if (!first || clickedTargets.has(first)) {
      console.warn(TAG, '[自动下一节] 展开后仍未找到下一章的小节（或已点击过）');
      return false;
    }
    clickedTargets.add(first); // 点击前登记，防止下轮重复点它
    console.log(TAG, '[自动下一节] 点击下一章第一节：', (first.textContent || '').trim());
    return await clickUntilNavChanged(rowCandidates(first), '下一章第一节', before);
  }

  /**
   * navViaNextButton —— 策略二（回退）：找"下一节"文字按钮点击。
   * 排除"自动进入下一节/自动连播"等设置项文字（≤8 字且不含这些词），
   * 避免误点播放器设置开关。
   */
  async function navViaNextButton(before) {
    const cands = findElementsByText(document.body, '下一节')
      .filter(isVisible)
      .filter((el) => {
        const t = (el.textContent || '').trim();
        return t.length <= 8 && !/自动|设置|连播/.test(t);
      })
      .sort((a, b) =>
        (a.textContent || '').trim().length - (b.textContent || '').trim().length);
    console.log(TAG, '[自动下一节] 策略二："下一节"按钮候选数', cands.length,
      cands.map((e) => (e.textContent || '').trim()));
    if (cands.length === 0) return false;
    await cdpClickElement(cands[0],
      '"下一节"按钮「' + (cands[0].textContent || '').trim() + '」');
    const ok = await verifyNavChanged(before);
    console.log(TAG, ok ? '[自动下一节] 页面已变化，切换成功（策略二）'
                        : '[自动下一节] 点击"下一节"按钮后页面无变化');
    return ok;
  }

  /**
   * waitForVideoProbe / probeOnce —— 跨框架视频探测（v1.2.9 新增）。
   * 背景：播放器可能在跨域 iframe 内，顶层无法直接读它的 video；而课程里
   * 存在无视频的"X.Y"目录层大节（如 1.2），点进去后必须能识别出来并继续
   * 进入其下一层（1.2.1）。
   * 机制：顶层发 videoProbe → background 广播 videoProbeRun 到本标签页所有
   * 框架 → 各框架检查本地是否存在已加载的 <video> → 经 background 把
   * videoProbeResult 转发回顶层 → 顶层任一框架报告有视频即返回 true。
   * probeOnce 单次探测最多等 waitMs；waitForVideoProbe 轮询发起直到超时
   * （点击切课后 SPA 渲染 + 播放器 iframe 加载需要数秒，单次探测会误判）。
   */
  let probeResolve = null; // 当前探测的收集器（收到有视频的报告时 resolve）
  function probeOnce(waitMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        probeResolve = null;
        resolve(v);
      };
      const timer = setTimeout(() => finish(false), waitMs);
      probeResolve = finish; // 先挂收集器再发起探测，保证报告不丢
      try {
        chrome.runtime.sendMessage({ type: 'videoProbe' }, () => {
          void chrome.runtime.lastError; // 扩展重载中等情况忽略
        });
      } catch (e) {
        finish(false); // runtime 失效（如刚重载扩展未刷新页面）
      }
    });
  }
  async function waitForVideoProbe(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await probeOnce(1500)) return true; // 任一框架报告有视频
    }
    return false;
  }

  /**
   * goToNextLesson —— 自动切换到下一节（仅顶层框架执行）。
   * v1.2.12 主流程（实测教训重塑）：
   *  - 签名验证在 SPA 页不可靠（点进导览页/大节后 URL、侧边栏高亮、主区域
   *    标题三信号全不更新），"验证失败"≠"没切过去"——所以不再以验证结果
   *    决定成败，统一以跨框架视频探测为准；
   *  - 每轮：策略一点击"下一个没点过的"目标 → 探测 8 秒内是否出现"可播的
   *    新视频"（点进大节/导览页则没有）→ 没有则下一轮按防重复点再下一个，
   *    直到进入有视频的页面（如 1.2 艺术与艺术品 → 1.2.1 艺术即感兴）；
   *  - 退出条件：两策略连点击都没发出过（解析失败/F12 占用等）立即报错；
   *    或 4 轮都没有可播视频（课程结构异常）放弃。
   */
  async function goToNextLesson() {
    for (let round = 1; round <= 4; round++) {
      if (round > 1) {
        console.log(TAG, '[自动下一节] 第 ' + round + ' 轮：尚未进入有视频的页面，尝试下一个候选…');
      }
      navClickAttempted = false; // 每轮重置"已点击"登记
      const before = navSignature();
      let switched = false;
      try {
        switched = await navViaSidebar(before);
      } catch (e) {
        console.warn(TAG, '[自动下一节] 策略一（侧边栏）异常：', (e && e.message) || e);
      }
      if (!switched) {
        try {
          switched = await navViaNextButton(before);
        } catch (e) {
          console.warn(TAG, '[自动下一节] 策略二（按钮）异常：', (e && e.message) || e);
        }
      }
      if (!switched && !navClickAttempted) {
        // 两策略既没确认成功、也确实一次点击都没发出——才是真失败
        console.error(TAG, '[自动下一节] 切换失败：两种策略均未发出有效点击。'
          + '若测试时开着 F12 请关闭后重试（真实点击需要 CDP 附加调试器）');
        return;
      }
      // 点击已发出（无论签名验证是否确认）→ 以视频探测为准判断是否切成功
      if (await waitForVideoProbe(8000)) {
        console.log(TAG, '[自动下一节] 新页面已有可播视频，自动切换完成');
        // v1.2.13：导航成功 → 清空 clickedTargets。
        // 这些目标只是本次导航过程中"试过"的候选，到达新页面后已无意义；
        // 若不清空，下一次视频播完时它们会被当作"已点击"永久跳过，
        // 导致跳过未播放的小节直接跳到更后面的课。
        clickedTargets = new WeakSet();
        return;
      }
      console.log(TAG, '[自动下一节] 新页面没有可播视频（可能进了目录层大节/导览条目），继续下一个候选');
    }
    console.error(TAG, '[自动下一节] 连续 4 轮进入的页面都没有可播视频，停止自动切换（请人工检查课程结构）');
  }

  /**
   * confirmVideoEnd —— 播完确认（防止小节内多段视频自动连播造成误触发）。
   * 触发后等 4 秒复核：若播放器已自动续播下一段（恢复播放、进度未到结尾），
   * 说明还没到小节末尾，取消切换；仍处于播完暂停状态才广播切换请求。
   * 发出请求前设 30 秒冷却，防止切换失败后每 2 秒重试形成风暴。
   */
  async function confirmVideoEnd(v) {
    await sleep(4000);
    const resumed = !v.paused && !v.ended && v.duration > 0 && v.currentTime < v.duration - 1;
    if (resumed) {
      console.log(TAG, '视频 4 秒后恢复播放（小节内分段连播），不切换下一节');
      pendingEndVideos.delete(v);
      return;
    }
    console.log(TAG, '确认视频已播完当前小节 → 请求切换下一节');
    pendingEndVideos.delete(v);
    // 30 秒冷却仅约束 videoEndPoll 的重新扫描（防切换失败后每 2 秒重试风暴），
    // 千万不能用它拦截 navigateNext 处理器：若视频与侧边栏同在顶层框架，
    // 刚设的冷却会把广播回来的切换请求"自己拦掉自己"（v1.2.6 实测踩坑）
    navCooldownUntil = Date.now() + 30000;
    try {
      chrome.runtime.sendMessage({ type: 'videoEnded' }, () => {
        if (chrome.runtime.lastError) {
          console.error(TAG, 'videoEnded 发送失败（若刚在扩展页重载过插件，请刷新学习页面）：',
            chrome.runtime.lastError.message);
        }
      });
    } catch (e) {
      console.error(TAG, 'videoEnded 发送异常（若刚在扩展页重载过插件，请刷新学习页面）：', e);
    }
  }

  /**
   * videoEndPoll —— 轮询本框架所有 <video>，发现"播放到结尾"即进入确认流程。
   * 判定：有时长且（ended 或 进度距结尾 <0.3s）。
   * pendingEndVideos 保证同一 video 只触发一次确认流程。
   */
  function videoEndPoll() {
    if (!enabled || processing) return;       // 开关关闭/弹窗处理中不监视
    if (Date.now() < navCooldownUntil) return; // 冷却期内不触发
    for (const v of document.querySelectorAll('video')) {
      if (v.duration > 0 && (v.ended || v.currentTime >= v.duration - 0.3)
          && !pendingEndVideos.has(v)) {
        pendingEndVideos.add(v);
        console.log(TAG, '检测到视频播放到结尾（时长 ' + v.duration.toFixed(1) + 's），4 秒后确认…');
        confirmVideoEnd(v);
      }
    }
  }

  /** startVideoWatcher / stopVideoWatcher —— 播完监视随总开关启停。 */
  function startVideoWatcher() {
    if (videoPollTimer) return;
    videoPollTimer = setInterval(videoEndPoll, 2000);
    console.log(TAG, '视频播完监视已启动（每 2 秒轮询）');
  }
  function stopVideoWatcher() {
    if (videoPollTimer) {
      clearInterval(videoPollTimer);
      videoPollTimer = null;
      console.log(TAG, '视频播完监视已停止');
    }
  }

  /**
   * handlePopup —— 一次弹窗的完整处理流程。
   * 0. 先附加调试器、等布局真正静止，最后才量坐标（v1.2.2 时序修正）；
   * 1. 同一容器只处理一次（WeakSet）；2. 选答案；3. 等 400ms；4. 提交；
   * 5. 设冷却期 + 处理反馈层；6. 结束后分离调试器。
   */
  async function handlePopup(popup) {
    const { container, submitBtn, type } = popup;

    // 去重1：同一容器元素只处理一次（防提交后状态变化被反复处理）
    if (processedContainers.has(container)) return;
    processedContainers.add(container);

    // 去重2：文字签名 + 5 秒时间窗（防新元素重复渲染）
    const signature = (container.textContent || '')
      .replace(/\s+/g, '')
      .slice(0, 200);
    const now = Date.now();
    if (signature === lastSignature && now - lastProcessTime < DEDUP_INTERVAL) {
      return;
    }
    lastSignature = signature;
    lastProcessTime = now;

    if (type !== 'single' && type !== 'multiple') return; // 其他题型不处理

    const rows = findOptionRows(container);
    if (rows.length === 0) {
      console.log(TAG, '未找到可点击选项，放弃本次');
      return;
    }
    // 多选全点，单选只点第一个（A）：随堂练习不计成绩，只为解除暂停
    const picked = type === 'multiple' ? rows : [rows[0]];
    console.log(TAG, '处理弹窗，题型：', type, '，目标选项：', picked.map((r) => r.letter).join(''));

    // ---- 第 0 步：先附加调试器 → 等布局真正静止 → 最后才量坐标 ----
    // v1.2.2 时序修正（旧版"固定等 350ms 后量坐标"导致点击点偏移、点空）：
    //   a) chrome.debugger 附加后浏览器顶部出现"已开始调试"提示条，网页可视区
    //      被压低、页面整体位移 —— 必须先 attach 让这次布局变化先发生，再量
    //      坐标，否则量好的坐标在点击时已经对不上；
    //   b) 弹窗入场动画（scale/translate 渐变）期间量取的矩形同样偏离最终
    //      位置。因此用"连续两次采样位置一致"判断真正静止，比固定延时可靠。
    // 附加成功后调试器保持附加到整个流程结束（finally 里统一分离），
    // 中途不再附加/分离，布局不会再次位移。
    const attached = await cdpAttach();
    console.log(TAG, attached
      ? '调试器已附加（浏览器顶部出现调试提示条属正常现象）'
      : '调试器附加失败（该页若开着 F12 请先关闭），稍后回退合成点击');
    await sleep(150);                    // 给入场动画一个起步时间
    await waitForRectStable(container);  // 等弹窗矩形连续两次采样一致（真正静止）

    try {
      // ---- 第 1 步：为每个选项挑选并校验点击坐标 ----
      const points = [];
      picked.forEach((r) => {
        const t = pickPointFor(r);
        if (!t) {
          console.warn(TAG, '选项', r.letter, '未找到有效可点坐标，跳过');
          return;
        }
        const hit = document.elementFromPoint(t.point.x, t.point.y);
        console.log(TAG, '选项', r.letter, '点击点', JSON.stringify(t.point),
          '依据:', t.by,
          '命中:', hit ? hit.tagName + '.' + (typeof hit.className === 'string' ? hit.className : '') : 'null');
        points.push(t.point);
      });
      if (points.length === 0) {
        console.warn(TAG, '所有选项均无有效坐标，放弃本次');
        return;
      }
      console.log(TAG, 'devicePixelRatio（缩放诊断）:', window.devicePixelRatio);
      debugMark(points); // 红点标记点击位置（3 秒消失），肉眼核对是否落在选项圆圈上

      // ---- 第 2 步：CDP 真实点击选项（失败回退合成事件） ----
      const okClick = await realClicks(points);
      if (okClick) {
        console.log(TAG, 'CDP 真实点击选项完成');
      } else {
        console.warn(TAG, 'CDP 不可用（该标签页若开着 F12 请关闭），回退合成点击');
        for (const r of picked) clickOption(r);
      }

      // ---- 第 3 步：等待前端状态同步后提交 ----
      await sleep(SELECT_DELAY);
      const okSubmit = await realClicks([centerOf(submitBtn)]);
      if (okSubmit) {
        console.log(TAG, 'CDP 真实点击提交完成');
      } else {
        console.warn(TAG, '提交回退合成点击');
        fireClick(submitBtn);
      }

      // 提交后冷却：此期间不重新检测，避免弹窗未消失被反复点击
      cooldownUntil = Date.now() + COOLDOWN;

      // 处理反馈层，让视频恢复播放（此时调试器仍附加，坐标不会漂移）
      await dismissFeedback(container);

      // ---- 第 4 步：恢复被弹窗暂停的视频（v1.2.3 新增） ----
      // 弹窗/反馈层关掉后，部分版本播放器不会自动续播：
      // 先等 300ms 让关闭动画/页面状态落定，再恢复本框架视频，
      // 并广播到同标签页所有框架（播放器可能在 iframe 里）。
      await sleep(300);
      await resumeVideo();
      broadcastResumeVideo();
    } finally {
      // 无论成功与否都分离调试器，浏览器顶部提示条随之消失
      if (attached) await cdpDetach();
    }
  }

  // ---------- 监听调度 ----------

  /**
   * onMutation —— 每次 DOM 变化后的调度入口。
   * 防抖：合并连续变化，下一次微任务统一检测一次。
   */
  let scheduled = false;
  function onMutation() {
    if (scheduled) return;
    scheduled = true;
    Promise.resolve().then(() => {
      scheduled = false;
      checkOnce();
    });
  }

  /**
   * checkOnce —— 单次检测+处理。
   * 用 processing 标志避免并发处理多个弹窗；
   * 提交后冷却期内不检测，防止弹窗未消失被反复点击。
   */
  function checkOnce() {
    if (!enabled || processing) return;
    if (Date.now() < cooldownUntil) return; // 冷却期内跳过
    const popup = detectPopup();
    if (!popup) return;
    processing = true;
    handlePopup(popup).finally(() => {
      processing = false;
    });
  }

  /**
   * startObserver —— 启动 MutationObserver + 定时轮询双保险。
   */
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(onMutation);
    observer.observe(document.body, {
      childList: true,       // 子节点增删
      subtree: true,        // 深层子树
      characterData: true,  // 文本变化（弹窗文字异步填充）
    });
    // 定时轮询兜底：部分框架异步渲染/Shadow 场景 observer 可能漏掉
    pollTimer = setInterval(checkOnce, POLL_INTERVAL);
    startVideoWatcher(); // v1.2.4：同时启动"视频播完自动下一节"监视
    console.log(TAG, '监听已启动（observer + 轮询 + 播完监视）');
    // 启动时也主动检测一次
    checkOnce();
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    stopVideoWatcher(); // v1.2.4：同步停止播完监视
    console.log(TAG, '监听已停止');
  }

  // ---------- 开关状态同步 ----------

  /**
   * 读取 storage 中的启用状态，决定是否启动 observer。
   * 默认开启（未存储时视为 true）。
   */
  function applyEnabledState() {
    chrome.storage.local.get(['autoAnswerEnabled'], (res) => {
      enabled = res.autoAnswerEnabled !== false; // 默认 true
      console.log(TAG, '开关状态：', enabled);
      if (enabled) startObserver();
      else stopObserver();
    });
  }

  // 监听 popup.js 改变开关后的实时同步
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'autoAnswerEnabled' in changes) {
      enabled = changes.autoAnswerEnabled.newValue !== false;
      console.log(TAG, '开关变更：', enabled);
      if (enabled) startObserver();
      else stopObserver();
    }
  });

  // 接收 background 广播：本框架内恢复视频（播放器可能在 iframe 中，
  // 各框架的 content script 各自恢复本地 video，已在播的会被自动跳过）
  chrome.runtime.onMessage.addListener((msg) => {
    // v1.2.12：判定"存在可播放的新视频"——duration>0 且未播完且未到结尾。
    // 不能只判"存在 video 元素"：发起切换的当前页视频已播完但元素还在，
    // 会误判为"新页面有视频"；导览页/大节页则根本没有 video 元素
    if (msg && msg.type === 'videoProbeRun') {
      let hasVideo = false;
      try {
        hasVideo = Array.prototype.some.call(
          document.querySelectorAll('video'),
          (v) => v.duration > 0 && !v.ended && v.currentTime < v.duration - 1);
      } catch (e) { /* 查询失败按无视频处理 */ }
      try {
        chrome.runtime.sendMessage({ type: 'videoProbeResult', hasVideo }, () => {
          void chrome.runtime.lastError;
        });
      } catch (e) { /* runtime 失效忽略 */ }
      return; // 不回包，报告走独立消息
    }
    // v1.2.9：视频探测报告 —— 仅顶层框架收集，任一框架有视频即放行等待中的探测
    if (msg && msg.type === 'videoProbeResult') {
      if (window.self === window.top && msg.hasVideo && probeResolve) {
        probeResolve(true);
      }
      return;
    }
    if (msg && msg.type === 'resumeVideoAll') {
      resumeVideo(); // 异步执行，无需回包
    }
    // v1.2.4：接收"切换下一节"广播 —— 仅顶层框架执行。
    // 视频播完信号可能来自 iframe 内的播放器，而章节侧边栏在顶层文档；
    // 顶层框架在此统一执行 goToNextLesson（策略一找按钮 / 策略二解析侧边栏）。
    if (msg && msg.type === 'navigateNext') {
      if (window.self !== window.top) return;   // 非顶层框架忽略
      if (!enabled) return;                     // 总开关关闭
      if (processing) {                         // 弹窗处理中，避免干扰作答流程
        console.log(TAG, '[自动下一节] 弹窗处理中，跳过本次切换');
        return;
      }
      // 不检查 navCooldownUntil（发起方刚设过 30 秒冷却，同框架会自己拦掉自己，
      // v1.2.6 实测踩坑）。防重复由 confirmVideoEnd 的 pendingEndVideos 保证；
      // 这里只防"多个框架同时触发"的并发点击。
      if (navInProgress) {
        console.log(TAG, '[自动下一节] 切换已在进行中，忽略重复请求');
        return;
      }
      navInProgress = true;
      goToNextLesson().catch((e) =>
        console.error(TAG, '[自动下一节] 切换流程异常：', (e && e.message) || e))
        .finally(() => { navInProgress = false; });
    }
  });

  // ---------- 启动 ----------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyEnabledState);
  } else {
    applyEnabledState();
  }
})();
