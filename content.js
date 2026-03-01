// YouTube 实时字幕翻译 - Content Script
//
// 核心问题：YouTube 每次字幕更新都会销毁并重建整个字幕 DOM，
// 所以不能把翻译元素插入到 YouTube 字幕内部（会被一起销毁）。
//
// 解决方案：
// 1. 翻译容器独立挂载在播放器上，不会被 YouTube 销毁
// 2. 用 requestAnimationFrame 持续跟踪原始字幕的位置
// 3. 翻译容器实时对齐到原始字幕的正下方

class YouTubeSubtitleTranslator {
  constructor() {
    this.transContainer = null;
    this.lastSubtitle = '';
    this.lastTranslatedText = '';
    this.observer = null;
    this.enabled = true;
    this.targetLang = 'zh-CN';
    this.translationCache = new Map();
    this.trackingRAF = null;

    this.init();
  }

  init() {
    console.log('[YT Translator] 初始化...');

    chrome.storage.sync.get(['enabled', 'targetLang'], (result) => {
      this.enabled = result.enabled !== false;
      this.targetLang = result.targetLang || 'zh-CN';

      if (this.enabled) {
        this.start();
      }
    });

    chrome.storage.onChanged.addListener((changes) => {
      if (changes.enabled) {
        this.enabled = changes.enabled.newValue;
        if (this.enabled) {
          this.start();
        } else {
          this.stop();
        }
      }
      if (changes.targetLang) {
        this.targetLang = changes.targetLang.newValue;
        this.translationCache.clear();
        this.lastSubtitle = '';
        this.lastTranslatedText = '';
      }
    });
  }

  start() {
    console.log('[YT Translator] 启动翻译...');
    this.ensureContainer();
    this.watchSubtitles();
    this.startTracking();
  }

  stop() {
    console.log('[YT Translator] 停止翻译...');

    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.trackingRAF) {
      cancelAnimationFrame(this.trackingRAF);
      this.trackingRAF = null;
    }
    if (this.transContainer) {
      this.transContainer.remove();
      this.transContainer = null;
    }
    this.lastSubtitle = '';
    this.lastTranslatedText = '';
  }

  // ========================
  // 创建独立的翻译容器
  // ========================

  ensureContainer() {
    if (this.transContainer && this.transContainer.parentElement) return;

    const waitForPlayer = () => {
      const player = document.querySelector('.html5-video-player');
      if (player) {
        this.transContainer = document.createElement('div');
        this.transContainer.id = 'yt-trans-container';
        player.appendChild(this.transContainer);
        console.log('[YT Translator] 翻译容器已创建');
      } else {
        setTimeout(waitForPlayer, 500);
      }
    };
    waitForPlayer();
  }

  // ========================
  // 持续跟踪原始字幕位置
  // ========================

  startTracking() {
    const track = () => {
      this.trackingRAF = requestAnimationFrame(track);
      this.alignToOriginalSubtitle();
    };
    this.trackingRAF = requestAnimationFrame(track);
  }

  alignToOriginalSubtitle() {
    if (!this.transContainer) return;

    const captionWindow = this.getOriginalCaptionWindow();
    if (!captionWindow || !this.lastTranslatedText) {
      this.transContainer.style.display = 'none';
      return;
    }

    const player = this.transContainer.parentElement;
    if (!player) return;

    const playerRect = player.getBoundingClientRect();

    // 找到所有 .ytp-caption-segment 计算实际文字的边界
    const segments = captionWindow.querySelectorAll('.ytp-caption-segment');
    if (segments.length === 0) {
      this.transContainer.style.display = 'none';
      return;
    }

    // 合并所有 segment 的 bounding rect，得到真正的文字区域
    let minLeft = Infinity, maxRight = -Infinity, maxBottom = -Infinity;
    for (const seg of segments) {
      const r = seg.getBoundingClientRect();
      if (r.width === 0) continue;
      minLeft = Math.min(minLeft, r.left);
      maxRight = Math.max(maxRight, r.right);
      maxBottom = Math.max(maxBottom, r.bottom);
    }

    if (minLeft === Infinity) {
      this.transContainer.style.display = 'none';
      return;
    }

    // 动态读取原始字幕的字体大小，缩小一号
    const originalFontSize = parseFloat(window.getComputedStyle(segments[0]).fontSize);
    this.transContainer.style.fontSize = (originalFontSize * 0.85) + 'px';

    // 计算文字区域的中心 X 和底部 Y（相对于播放器）
    const textCenterX = (minLeft + maxRight) / 2 - playerRect.left;
    const textBottom = maxBottom - playerRect.top + 2;

    this.transContainer.style.display = 'block';
    this.transContainer.style.left = textCenterX + 'px';
    this.transContainer.style.top = textBottom + 'px';
  }

  // ========================
  // 找到 YouTube 原始字幕窗口
  // ========================

  getOriginalCaptionWindow() {
    // YouTube 字幕可能的容器 class
    const windows = document.querySelectorAll(
      '.caption-window, .ytp-caption-window-bottom, .ytp-caption-window-top'
    );
    for (const w of windows) {
      // 排除我们自己的容器
      if (w.id === 'yt-trans-container') continue;
      // 必须包含字幕文本
      if (w.querySelector('.ytp-caption-segment')) {
        return w;
      }
    }
    return null;
  }

  // ========================
  // 监控字幕变化
  // ========================

  watchSubtitles() {
    const player = document.querySelector('.html5-video-player');
    if (!player) {
      setTimeout(() => this.watchSubtitles(), 1000);
      return;
    }

    console.log('[YT Translator] 开始监控字幕变化');

    if (this.observer) {
      this.observer.disconnect();
    }

    this.observer = new MutationObserver(() => {
      this.onSubtitleMutation();
    });

    this.observer.observe(player, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // 立即检测一次
    this.onSubtitleMutation();
  }

  onSubtitleMutation() {
    // 读取原始字幕文本
    const segments = document.querySelectorAll('.ytp-caption-segment');
    let currentText = '';

    for (const seg of segments) {
      // 确保不是我们自己容器内的内容
      if (!seg.closest('#yt-trans-container')) {
        currentText += seg.textContent;
      }
    }

    currentText = currentText.trim();

    if (!currentText) {
      // 字幕消失了
      this.lastSubtitle = '';
      this.lastTranslatedText = '';
      this.updateDisplay('');
      return;
    }

    // 文本没变就不重新翻译
    if (currentText === this.lastSubtitle) return;

    this.lastSubtitle = currentText;

    // 如果缓存里有直接用
    if (this.translationCache.has(currentText)) {
      const translated = this.translationCache.get(currentText);
      this.lastTranslatedText = translated;
      this.updateDisplay(translated);
      return;
    }

    // 异步翻译
    this.translateText(currentText);
  }

  async translateText(text) {
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${this.targetLang}&dt=t&q=${encodeURIComponent(text)}`;
      const response = await fetch(url);
      const data = await response.json();

      if (data && data[0] && data[0][0] && data[0][0][0]) {
        const translated = data[0].map(item => item[0]).join('');
        this.translationCache.set(text, translated);

        // 只有当前字幕没变时才显示（防止异步回来后字幕已更新）
        if (this.lastSubtitle === text) {
          this.lastTranslatedText = translated;
          this.updateDisplay(translated);
        }
      }
    } catch (error) {
      console.error('[YT Translator] 翻译失败:', error);
    }
  }

  updateDisplay(text) {
    if (!this.transContainer) return;

    if (!text) {
      this.transContainer.textContent = '';
      this.transContainer.style.display = 'none';
    } else {
      this.transContainer.textContent = text;
      // display 由 alignToOriginalSubtitle 控制
    }
  }
}

// ========================
// 启动
// ========================

if (window.location.hostname === 'www.youtube.com') {
  const translator = new YouTubeSubtitleTranslator();

  // 监听 YouTube SPA 页面导航
  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      if (url.includes('/watch')) {
        setTimeout(() => translator.start(), 1000);
      }
    }
  }).observe(document, { subtree: true, childList: true });
}
