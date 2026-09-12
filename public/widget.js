/* Horus Desk Widget v1.0.0 */
(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined'
    ? module.exports = factory()
    : typeof define === 'function' && define.amd
    ? define(factory)
    : (global = typeof globalThis !== 'undefined' ? globalThis : global || self, global.HorusDesk = factory());
})(this, function () {
  'use strict';

  // ============================================
  // CONFIGURATION & STATE
  // ============================================
  const WIDGET_VERSION = '1.1.0';
  const STORAGE_PREFIX = 'horus_';
  const CONFIG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  const SESSION_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
  const INACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 minutes
  const CONFIG_REFRESH_INTERVAL = 60 * 1000; // 60 seconds
  const DORMANT_POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes
  const DEFAULT_API_ENDPOINT = 'https://oknqxlmyhmxbzqtnlraq.supabase.co/functions/v1';

  // ============================================
  // UTILITY FUNCTIONS
  // ============================================

  /**
   * Generate UUID v4 (with polyfill for older browsers)
   */
  function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    // Polyfill
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Debounce function
   */
  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  /**
   * Throttle function
   */
  function throttle(func, limit) {
    let inThrottle;
    return function (...args) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => (inThrottle = false), limit);
      }
    };
  }

  /**
   * Sanitize HTML - allow-list approach
   * Only allows: <br>, <strong>, <em>, <a> (with target="_blank" rel="noopener")
   */
  function sanitizeHTML(input) {
    if (!input || typeof input !== 'string') return '';

    // Create a temporary element
    const temp = document.createElement('div');
    temp.textContent = input;
    let text = temp.innerHTML;

    // Convert \n to <br>
    text = text.replace(/\n/g, '<br>');

    // Allowed tags with their allowed attributes
    const allowedTags = {
      br: [],
      strong: [],
      em: [],
      a: ['href', 'target', 'rel'],
    };

    // Replace allowed tags (process in order)
    const tagRegex = /&lt;(\/?)(\w+)(.*?)&gt;/g;
    text = text.replace(tagRegex, (match, closing, tagName, attrs) => {
      const lowerTag = tagName.toLowerCase();
      if (!allowedTags[lowerTag]) return '';

      if (closing) {
        return `</${lowerTag}>`;
      }

      // Parse and filter attributes
      let allowedAttrs = '';
      if (allowedTags[lowerTag].length > 0) {
        const attrRegex = /(\w+)=&quot;([^&]*)&quot;/g;
        let attrMatch;
        while ((attrMatch = attrRegex.exec(attrs)) !== null) {
          const attrName = attrMatch[1].toLowerCase();
          const attrValue = attrMatch[2];
          if (allowedTags[lowerTag].includes(attrName)) {
            // Validate href for links
            if (attrName === 'href') {
              if (!/^https?:\/\//i.test(attrValue)) continue;
            }
            allowedAttrs += ` ${attrName}="${attrValue}"`;
          }
        }
        // Add security attributes for links
        if (lowerTag === 'a') {
          allowedAttrs += ' target="_blank" rel="noopener noreferrer"';
        }
      }

      return `<${lowerTag}${allowedAttrs}>`;
    });

    return text;
  }

  /**
   * Escape HTML for text content
   */
  function escapeHTML(text) {
    if (!text || typeof text !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Format AI message: escape HTML, then convert markdown bold/italic/links to HTML
   */
  function formatAIMessage(input) {
    if (!input || typeof input !== 'string') return '';

    // Escape HTML first (security)
    const div = document.createElement('div');
    div.textContent = input;
    let text = div.innerHTML;

    // Convert \n to <br>
    text = text.replace(/\n/g, '<br>');

    // Markdown links: [text](url) → clickable <a> (only http/https)
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // Bare URLs not already inside an href → clickable <a>
    text = text.replace(/(?<!href=&quot;)(?<!href=")(https?:\/\/[^\s<]+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');

    // Bold: **text** or __text__
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');

    // Italic: *text* or _text_ (but not inside words for underscores)
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
    text = text.replace(/(?<!\w)_(.+?)_(?!\w)/g, '<em>$1</em>');

    return text;
  }

  /**
   * Deep merge objects
   */
  function deepMerge(target, source) {
    const output = Object.assign({}, target);
    if (isObject(target) && isObject(source)) {
      Object.keys(source).forEach((key) => {
        if (isObject(source[key])) {
          if (!(key in target)) {
            Object.assign(output, { [key]: source[key] });
          } else {
            output[key] = deepMerge(target[key], source[key]);
          }
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      });
    }
    return output;
  }

  function isObject(item) {
    return item && typeof item === 'object' && !Array.isArray(item);
  }

  /**
   * Get current timestamp in ISO format
   */
  function getISOTimestamp() {
    return new Date().toISOString();
  }

  /**
   * Check if timestamp is within max age
   */
  function isWithinAge(timestamp, maxAge) {
    if (!timestamp) return false;
    const age = Date.now() - new Date(timestamp).getTime();
    return age < maxAge;
  }

  /**
   * Format time for display
   */
  function formatTime(date) {
    const d = new Date(date);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ============================================
  // STORAGE MANAGEMENT
  // ============================================

  class StorageManager {
    constructor(apiKey) {
      this.prefix = STORAGE_PREFIX + apiKey + '_';
    }

    _key(name) {
      return this.prefix + name;
    }

    get(key) {
      try {
        const item = localStorage.getItem(this._key(key));
        return item ? JSON.parse(item) : null;
      } catch (e) {
        return null;
      }
    }

    set(key, value) {
      try {
        localStorage.setItem(this._key(key), JSON.stringify(value));
        return true;
      } catch (e) {
        return false;
      }
    }

    remove(key) {
      try {
        localStorage.removeItem(this._key(key));
        return true;
      } catch (e) {
        return false;
      }
    }

    clear() {
      try {
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith(this.prefix)) {
            keysToRemove.push(key);
          }
        }
        keysToRemove.forEach((key) => localStorage.removeItem(key));
        return true;
      } catch (e) {
        return false;
      }
    }

    getSessionId() {
      const session = this.get('session');
      if (session && session.id && isWithinAge(session.createdAt, SESSION_MAX_AGE)) {
        return session.id;
      }
      return null;
    }

    createSession() {
      const session = {
        id: generateUUID(),
        createdAt: getISOTimestamp(),
        lastActivity: getISOTimestamp(),
      };
      this.set('session', session);
      return session.id;
    }

    updateActivity() {
      const session = this.get('session');
      if (session) {
        session.lastActivity = getISOTimestamp();
        this.set('session', session);
      }
    }

    isSessionValid() {
      const session = this.get('session');
      return session && session.id && isWithinAge(session.createdAt, SESSION_MAX_AGE);
    }

    getMessages() {
      return this.get('messages') || [];
    }

    addMessage(message) {
      const messages = this.getMessages();
      messages.push({
        ...message,
        timestamp: getISOTimestamp(),
      });
      this.set('messages', messages);
      this.updateActivity();
      return messages;
    }

    clearMessages() {
      this.remove('messages');
    }

    getVisitorData() {
      return this.get('visitor_data') || {};
    }

    setVisitorData(data) {
      this.set('visitor_data', data);
    }

    getConfig() {
      const cached = this.get('config');
      if (cached && cached.data && isWithinAge(cached.timestamp, CONFIG_CACHE_TTL)) {
        return cached.data;
      }
      return null;
    }

    setConfig(config) {
      this.set('config', {
        data: config,
        timestamp: getISOTimestamp(),
      });
    }

    wasSurveyShown() {
      return this.get('survey_shown') === true;
    }

    markSurveyShown() {
      this.set('survey_shown', true);
    }
  }

  // ============================================
  // API CLIENT
  // ============================================

  class APIClient {
    constructor(config) {
      this.apiKey = config.apiKey;
      this.apiEndpoint = config.apiEndpoint || DEFAULT_API_ENDPOINT;
      this.abortControllers = [];
    }

    _getHeaders() {
      return {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey,
        'X-Widget-Version': WIDGET_VERSION,
      };
    }

    async fetchConfig() {
      const controller = new AbortController();
      this.abortControllers.push(controller);

      try {
        const response = await fetch(
          `${this.apiEndpoint}/widget-config?apiKey=${encodeURIComponent(this.apiKey)}`,
          {
            method: 'GET',
            headers: this._getHeaders(),
            signal: controller.signal,
          }
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        return { success: true, data };
      } catch (error) {
        if (error.name === 'AbortError') {
          return { success: false, aborted: true };
        }
        return { success: false, error: error.message };
      } finally {
        this._removeController(controller);
      }
    }

    async fetchHistory(sessionId) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
      this.abortControllers.push(controller);

      try {
        const response = await fetch(
          `${this.apiEndpoint}/widget-chat?apiKey=${encodeURIComponent(this.apiKey)}&sessionId=${encodeURIComponent(sessionId)}`,
          {
            method: 'GET',
            headers: this._getHeaders(),
            signal: controller.signal,
          }
        );

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        return { success: true, data };
      } catch (error) {
        return { success: false, error: error.message };
      } finally {
        this._removeController(controller);
      }
    }

    async sendChat(sessionId, visitorData, message, metadata, onDelta) {
      const controller = new AbortController();
      // With streaming enabled the AI writes the reply live, so a single flat
      // timeout would cut long answers off — instead abort only on stalls
      // (no chunk for 45s). Non-streaming keeps the original flat 60s.
      let timeoutId = setTimeout(() => controller.abort(), onDelta ? 45000 : 60000);
      const armStallTimer = () => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => controller.abort(), 45000);
      };
      this.abortControllers.push(controller);

      try {
        const response = await fetch(`${this.apiEndpoint}/widget-chat`, {
          method: 'POST',
          headers: this._getHeaders(),
          body: JSON.stringify({
            apiKey: this.apiKey,
            sessionId,
            visitorData,
            message,
            timestamp: getISOTimestamp(),
            metadata,
            stream: true,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        // Streaming SSE reply — forward text deltas as they arrive
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/event-stream') && response.body) {
          const result = await this._readChatStream(response.body, armStallTimer, onDelta);
          clearTimeout(timeoutId);
          return result;
        }

        clearTimeout(timeoutId);
        const data = await response.json();
        return { success: true, data };
      } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
          return { success: false, timeout: true };
        }
        return { success: false, error: error.message };
      } finally {
        this._removeController(controller);
      }
    }

    /**
     * Read a widget-chat SSE stream: {type:"delta",text} events as the reply
     * generates, then one terminal {type:"done",…} or {type:"error",…}.
     */
    async _readChatStream(streamBody, onChunk, onDelta) {
      const reader = streamBody.getReader();
      const decoder = new TextDecoder();
      let lineBuf = '';
      let donePayload = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        onChunk();
        lineBuf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, nl).trim();
          lineBuf = lineBuf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          let evt;
          try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (evt.type === 'delta' && evt.text) {
            if (onDelta) onDelta(evt.text);
          } else if (evt.type === 'done') {
            donePayload = evt;
          } else if (evt.type === 'error') {
            return { success: false, error: evt.error || 'Stream failed' };
          }
        }
      }
      if (!donePayload) return { success: false, error: 'Stream ended unexpectedly' };
      return { success: true, data: donePayload, streamed: true };
    }

    async submitSurvey(surveyData) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      this.abortControllers.push(controller);

      try {
        const response = await fetch(`${this.apiEndpoint}/widget-survey`, {
          method: 'POST',
          headers: this._getHeaders(),
          body: JSON.stringify({
            ...surveyData,
            apiKey: this.apiKey,
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      } finally {
        this._removeController(controller);
      }
    }

    _removeController(controller) {
      const index = this.abortControllers.indexOf(controller);
      if (index > -1) {
        this.abortControllers.splice(index, 1);
      }
    }

    abortAll() {
      this.abortControllers.forEach((controller) => {
        try {
          controller.abort();
        } catch (e) {
          // Ignore
        }
      });
      this.abortControllers = [];
    }
  }

  // ============================================
  // SVG ICONS (INLINE)
  // ============================================

  const ICONS = {
    chat: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`,
    close: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
    send: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`,
    star: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`,
    starOutline: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`,
    robot: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><line x1="8" y1="16" x2="8" y2="16"></line><line x1="16" y1="16" x2="16" y2="16"></line></svg>`,
    check: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
    warning: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`,
    arrowRight: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>`,
  };

  // ============================================
  // CSS STYLES
  // ============================================

  function getStyles(config, isDarkMode) {
    const colors = isDarkMode && config.colors?.dark ? config.colors.dark : config.colors?.light || config.colors;

    // True only when the tenant's DARK palette is actually in effect — not merely
    // when the visitor's OS prefers dark. Input surfaces must follow the active
    // palette; keying them off the OS causes dark-text-on-dark-field (or the
    // reverse) whenever a tenant hasn't configured a matching OS theme.
    const isDarkPalette = isDarkMode && !!config.colors?.dark;

    // The input field pill must ALWAYS pair with inputText. Derive it from the
    // tenant's own input colors (8% text over input-area bg) so any palette —
    // dark, light, branded — stays readable. color-mix is supported by all
    // browsers since 2023; fall back to palette-based grays otherwise.
    const supportsColorMix = typeof CSS !== "undefined" &&
      !!CSS.supports && CSS.supports("color", "color-mix(in srgb, red 10%, blue)");
    const defaultFieldBg = supportsColorMix
      ? "color-mix(in srgb, var(--horus-input-text) 8%, var(--horus-input-bg))"
      : (isDarkPalette ? "#374151" : "#f3f4f6");
    const placeholderColor = supportsColorMix
      ? "color-mix(in srgb, var(--horus-input-text) 55%, transparent)"
      : (isDarkPalette ? "#9ca3af" : "#6b7280");

    return `
      :host {
        --horus-header-bg: ${colors.headerBg || '#2563eb'};
        --horus-header-text: ${colors.headerText || '#ffffff'};
        --horus-user-bubble: ${colors.userBubble || '#2563eb'};
        --horus-user-text: ${colors.userText || '#ffffff'};
        --horus-ai-bubble: ${colors.aiBubble || '#f3f4f6'};
        --horus-ai-text: ${colors.aiText || '#1f2937'};
        --horus-bg: ${colors.bg || '#ffffff'};
        --horus-input-bg: ${colors.inputBg || '#ffffff'};
        --horus-input-text: ${colors.inputText || '#1f2937'};
        --horus-input-field-bg: ${colors.inputFieldBg || defaultFieldBg};
        --horus-send-btn: ${colors.sendBtn || '#2563eb'};
        --horus-send-btn-text: ${colors.sendBtnText || '#ffffff'};
        --horus-border: ${isDarkMode ? '#374151' : '#e5e7eb'};
        --horus-shadow: ${isDarkMode ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.1)'};
        --horus-error: #ef4444;
        --horus-success: #10b981;
        --horus-warning: #f59e0b;
        
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      }

      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }

      /* FAB Button */
      .horus-fab {
        position: fixed;
        ${config.position === 'left' ? 'left: 24px;' : 'right: 24px;'}
        bottom: 24px;
        width: 56px;
        height: 56px;
        border-radius: 50%;
        background: var(--horus-header-bg);
        color: var(--horus-header-text);
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        z-index: 999998;
        transition: transform 0.2s ease, box-shadow 0.2s ease;
      }

      .horus-fab:hover {
        transform: scale(1.05);
        box-shadow: 0 6px 16px rgba(0,0,0,0.2);
      }

      .horus-fab:active {
        transform: scale(0.95);
      }

      .horus-fab svg {
        width: 24px;
        height: 24px;
      }

      /* Chat Window */
      .horus-chat-window {
        position: fixed;
        ${config.position === 'left' ? 'left: 24px;' : 'right: 24px;'}
        bottom: 96px;
        width: 380px;
        max-height: min(600px, calc(100vh - 120px));
        background: var(--horus-bg);
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.2);
        z-index: 999999;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        opacity: 0;
        transform: translateY(20px) scale(0.95);
        pointer-events: none;
        transition: opacity 0.3s ease, transform 0.3s ease;
      }

      .horus-chat-window.open {
        opacity: 1;
        transform: translateY(0) scale(1);
        pointer-events: auto;
      }

      @media (max-width: 480px) {
  		.horus-chat-window {
    		position: fixed;
    		top: 0;
    		left: 0;
    		right: 0;
    		bottom: 0;
    		width: 100vw;
    		height: 100%;
    		max-height: 100%;
    		border-radius: 0;
    		${config.position === 'left' ? '' : ''}
  		}

        .horus-fab {
          ${config.position === 'left' ? 'left: 16px;' : 'right: 16px;'}
          bottom: max(16px, env(safe-area-inset-bottom));
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .horus-chat-window,
        .horus-fab {
          transition: none !important;
        }
      }

      /* Header */
      .horus-header {
        background: var(--horus-header-bg);
        color: var(--horus-header-text);
        padding: 16px 20px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-shrink: 0;
      }

      .horus-header-title {
        font-size: 16px;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .horus-header-actions {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .horus-header-btn {
        background: none;
        border: none;
        color: inherit;
        cursor: pointer;
        padding: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0.9;
        transition: opacity 0.2s;
        font-size: 13px;
        min-height: 44px;
        min-width: 44px;
      }

      .horus-header-btn:hover {
        opacity: 1;
      }

      .horus-header-btn svg {
        width: 20px;
        height: 20px;
      }

      /* Messages Area */
      .horus-messages {
        flex: 1;
        overflow-y: auto;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        scroll-behavior: smooth;
      }

      .horus-message {
        display: flex;
        gap: 10px;
        max-width: 85%;
        animation: messageAppear 0.2s ease;
      }

      @keyframes messageAppear {
        from {
          opacity: 0;
          transform: translateY(10px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      .horus-message.user {
        align-self: flex-end;
        flex-direction: row-reverse;
      }

      .horus-message.ai {
        align-self: flex-start;
      }

      .horus-message-avatar {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: var(--horus-header-bg);
        color: var(--horus-header-text);
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }

      .horus-message-avatar svg {
        width: 18px;
        height: 18px;
      }

      .horus-message-content {
        padding: 12px 16px;
        border-radius: 16px;
        font-size: 14px;
        line-height: 1.5;
        word-wrap: break-word;
      }

      .horus-message.user .horus-message-content {
        background: var(--horus-user-bubble);
        color: var(--horus-user-text);
        border-bottom-right-radius: 4px;
      }

      .horus-message.ai .horus-message-content {
        background: var(--horus-ai-bubble);
        color: var(--horus-ai-text);
        border-bottom-left-radius: 4px;
      }

      .horus-message-content a {
        color: inherit;
        text-decoration: underline;
      }

      .horus-message-time {
        font-size: 11px;
        opacity: 0.6;
        margin-top: 4px;
        text-align: right;
      }

      /* Quick Replies */
      .horus-quick-replies {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 8px;
        padding-left: 42px;
      }

      .horus-quick-reply {
        background: var(--horus-header-bg);
        color: var(--horus-header-text);
        border: none;
        padding: 8px 16px;
        border-radius: 16px;
        font-size: 13px;
        cursor: pointer;
        transition: opacity 0.2s, transform 0.1s;
        white-space: nowrap;
        min-height: 36px;
      }

      .horus-quick-reply:hover {
        opacity: 0.9;
      }

      .horus-quick-reply:active {
        transform: scale(0.95);
      }

      /* Typing Indicator */
      .horus-typing {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 16px;
        align-self: flex-start;
      }

      .horus-typing-dot {
        width: 8px;
        height: 8px;
        background: var(--horus-ai-text);
        opacity: 0.4;
        border-radius: 50%;
        animation: typingBounce 1.4s infinite ease-in-out both;
      }

      .horus-typing-dot:nth-child(1) { animation-delay: -0.32s; }
      .horus-typing-dot:nth-child(2) { animation-delay: -0.16s; }

      @keyframes typingBounce {
        0%, 80%, 100% { transform: scale(0); }
        40% { transform: scale(1); }
      }

      /* Input Area */
      .horus-input-area {
  		padding: 12px 16px;
  		border-top: 1px solid var(--horus-border);
  		background: var(--horus-input-bg);
  		display: flex;
  		gap: 12px;
  		align-items: flex-end;
  		padding-bottom: max(12px, env(safe-area-inset-bottom));
  		flex-shrink: 0;
	   }

      .horus-input {
        flex: 1;
        background: var(--horus-input-field-bg);
        border: 1px solid transparent;
        border-radius: 20px;
        padding: 10px 16px;
        font-size: 14px;
        color: var(--horus-input-text);
        resize: none;
        min-height: 40px;
        max-height: 100px;
        font-family: inherit;
        line-height: 1.4;
        outline: none;
        transition: border-color 0.2s;
      }

      .horus-input:focus {
        border-color: var(--horus-header-bg);
      }

      .horus-input:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .horus-input::placeholder {
        color: ${placeholderColor};
      }

      .horus-send-btn {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: var(--horus-send-btn);
        color: var(--horus-send-btn-text);
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        transition: opacity 0.2s, transform 0.1s;
        min-height: 44px;
        min-width: 44px;
      }

      .horus-send-btn:hover:not(:disabled) {
        opacity: 0.9;
      }

      .horus-send-btn:active:not(:disabled) {
        transform: scale(0.95);
      }

      .horus-send-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .horus-send-btn svg {
        width: 18px;
        height: 18px;
        margin-left: 2px;
      }

      /* Pre-chat Form Overlay */
      .horus-form-overlay {
        position: absolute;
        inset: 0;
        background: var(--horus-bg);
        z-index: 10;
        display: flex;
        flex-direction: column;
        padding: 24px;
        overflow-y: auto;
      }

      .horus-form-title {
        font-size: 20px;
        font-weight: 600;
        color: var(--horus-input-text);
        margin-bottom: 4px;
      }

      .horus-form-subtitle {
        font-size: 14px;
        color: ${isDarkMode ? '#9ca3af' : '#6b7280'};
        margin-bottom: 24px;
      }

      .horus-form-group {
        margin-bottom: 16px;
      }

      .horus-form-label {
        display: block;
        font-size: 14px;
        font-weight: 500;
        color: var(--horus-input-text);
        margin-bottom: 6px;
      }

      .horus-form-label .required {
        color: var(--horus-error);
        margin-left: 2px;
      }

      .horus-form-input {
        width: 100%;
        padding: 12px 16px;
        border: 1px solid var(--horus-border);
        border-radius: 8px;
        font-size: 14px;
        background: var(--horus-input-bg);
        color: var(--horus-input-text);
        transition: border-color 0.2s, box-shadow 0.2s;
        font-family: inherit;
      }

      .horus-form-input:focus {
        outline: none;
        border-color: var(--horus-header-bg);
        box-shadow: 0 0 0 3px ${colors.headerBg}20;
      }

      .horus-form-input.error {
        border-color: var(--horus-error);
      }

      .horus-form-error {
        font-size: 12px;
        color: var(--horus-error);
        margin-top: 4px;
      }

      .horus-form-submit {
        width: 100%;
        padding: 14px;
        background: var(--horus-header-bg);
        color: var(--horus-header-text);
        border: none;
        border-radius: 8px;
        font-size: 15px;
        font-weight: 500;
        cursor: pointer;
        transition: opacity 0.2s;
        margin-top: 8px;
        min-height: 48px;
      }

      .horus-form-submit:hover {
        opacity: 0.9;
      }

      /* Survey Modal */
      .horus-survey-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.5);
        backdrop-filter: blur(4px);
        z-index: 1000000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.3s ease;
      }

      .horus-survey-overlay.open {
        opacity: 1;
        pointer-events: auto;
      }

      .horus-survey-modal {
        background: var(--horus-bg);
        border-radius: 12px;
        width: 100%;
        max-width: 420px;
        max-height: 90vh;
        overflow-y: auto;
        padding: 24px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        transform: scale(0.95);
        transition: transform 0.3s ease;
      }

      .horus-survey-overlay.open .horus-survey-modal {
        transform: scale(1);
      }

      .horus-survey-title {
        font-size: 18px;
        font-weight: 600;
        color: var(--horus-input-text);
        margin-bottom: 20px;
      }

      .horus-survey-question {
        margin-bottom: 20px;
      }

      .horus-survey-label {
        font-size: 14px;
        color: ${isDarkMode ? '#d1d5db' : '#4b5563'};
        margin-bottom: 10px;
        display: block;
      }

      .horus-survey-stars {
        display: flex;
        gap: 8px;
      }

      .horus-survey-star {
        background: none;
        border: none;
        cursor: pointer;
        padding: 4px;
        color: ${isDarkMode ? '#4b5563' : '#d1d5db'};
        transition: color 0.2s, transform 0.1s;
        min-height: 44px;
        min-width: 44px;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .horus-survey-star:hover,
      .horus-survey-star.active {
        color: #fbbf24;
      }

      .horus-survey-star:hover {
        transform: scale(1.1);
      }

      .horus-survey-toggle {
        display: flex;
        gap: 12px;
      }

      .horus-survey-toggle-btn {
        flex: 1;
        padding: 10px 16px;
        border: 1px solid var(--horus-border);
        background: var(--horus-input-bg);
        color: var(--horus-input-text);
        border-radius: 8px;
        cursor: pointer;
        font-size: 14px;
        transition: all 0.2s;
        min-height: 44px;
      }

      .horus-survey-toggle-btn.active {
        background: var(--horus-header-bg);
        color: var(--horus-header-text);
        border-color: var(--horus-header-bg);
      }

      .horus-survey-textarea {
        width: 100%;
        min-height: 100px;
        padding: 12px;
        border: 1px solid var(--horus-border);
        border-radius: 8px;
        font-size: 14px;
        background: var(--horus-input-bg);
        color: var(--horus-input-text);
        resize: vertical;
        font-family: inherit;
      }

      .horus-survey-textarea:focus {
        outline: none;
        border-color: var(--horus-header-bg);
      }

      .horus-survey-char-count {
        font-size: 12px;
        color: ${isDarkMode ? '#9ca3af' : '#6b7280'};
        text-align: right;
        margin-top: 4px;
      }

      .horus-survey-actions {
        display: flex;
        gap: 12px;
        margin-top: 24px;
      }

      .horus-survey-btn {
        flex: 1;
        padding: 12px;
        border-radius: 8px;
        font-size: 15px;
        font-weight: 500;
        cursor: pointer;
        transition: opacity 0.2s;
        min-height: 48px;
      }

      .horus-survey-btn-primary {
        background: var(--horus-header-bg);
        color: var(--horus-header-text);
        border: none;
      }

      .horus-survey-btn-secondary {
        background: transparent;
        color: ${isDarkMode ? '#d1d5db' : '#4b5563'};
        border: 1px solid var(--horus-border);
      }

      .horus-survey-btn:hover {
        opacity: 0.9;
      }

      /* Toast Notification */
      .horus-toast {
        position: fixed;
        bottom: 100px;
        left: 50%;
        transform: translateX(-50%) translateY(20px);
        background: ${isDarkMode ? '#1f2937' : '#1f2937'};
        color: white;
        padding: 12px 24px;
        border-radius: 8px;
        font-size: 14px;
        z-index: 1000001;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.3s, transform 0.3s;
      }

      .horus-toast.show {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }

      /* Error Banner */
      .horus-error-banner {
        background: var(--horus-error);
        color: white;
        padding: 12px 16px;
        font-size: 13px;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .horus-error-banner svg {
        flex-shrink: 0;
      }

      .horus-retry-btn {
        background: white;
        color: var(--horus-error);
        border: none;
        padding: 4px 12px;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        margin-left: auto;
      }

      /* Disable Banner */
      .horus-disable-banner {
        background: var(--horus-warning);
        color: #1f2937;
        padding: 12px 16px;
        font-size: 13px;
        text-align: center;
      }

      /* Powered By */
      .horus-powered-by {
        text-align: center;
        padding: 8px;
        font-size: 11px;
        color: ${isDarkMode ? '#6b7280' : '#9ca3af'};
        border-top: 1px solid var(--horus-border);
      }

      .horus-powered-by a {
        color: inherit;
        text-decoration: none;
        font-weight: 500;
      }

      .horus-powered-by a:hover {
        text-decoration: underline;
      }

      /* Scrollbar Styling */
      .horus-messages::-webkit-scrollbar {
        width: 6px;
      }

      .horus-messages::-webkit-scrollbar-track {
        background: transparent;
      }

      .horus-messages::-webkit-scrollbar-thumb {
        background: ${isDarkMode ? '#4b5563' : '#d1d5db'};
        border-radius: 3px;
      }

      .horus-messages::-webkit-scrollbar-thumb:hover {
        background: ${isDarkMode ? '#6b7280' : '#9ca3af'};
      }

      /* Focus Trap Indicator */
      .horus-focusable:focus {
        outline: 2px solid var(--horus-header-bg);
        outline-offset: 2px;
      }

      .horus-focusable:focus:not(:focus-visible) {
        outline: none;
      }
    `;
  }

  // ============================================
  // MAIN WIDGET CLASS
  // ============================================

  class HorusDeskWidget {
    constructor() {
      this.config = null;
      this.storage = null;
      this.api = null;
      this.shadowRoot = null;
      this.hostElement = null;
      this.isOpen = false;
      this.isDarkMode = false;
      this.isLoading = false;
      this.isSyncingHistory = false;
      this.messages = [];
      this.sessionId = null;
      this.visitorData = {};
      this.focusableElements = [];
      this.previouslyFocusedElement = null;
      this.configRefreshInterval = null;
      this.inactivityCheckInterval = null;
      this.dormantPollInterval = null;
      this.isDormant = false;
      this.lastMessageTime = null;
      this.quickReplySetId = 0;
      this.activeQuickReplySet = null;
      this.pendingMessage = null;
      this.retryAfter = 300;
      this.streamMessageEl = null;  // live bubble while a reply streams in
      this.streamText = '';

      // Bind methods
      this.handleKeyDown = this.handleKeyDown.bind(this);
      this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
      this.handleResize = this.handleResize.bind(this);
      this.handleThemeChange = this.handleThemeChange.bind(this);
      this.checkInactivity = this.checkInactivity.bind(this);
      this.refreshConfig = this.refreshConfig.bind(this);
      this.pollDormant = this.pollDormant.bind(this);
    }

    /**
     * Initialize the widget
     */
    async init() {
      // Check for required config
      const snippetConfig = window.horusDesk || {};
      if (!snippetConfig.apiKey) {
        console.error('[Horus] apiKey required');
        return false;
      }

      // Initialize storage and API
      this.storage = new StorageManager(snippetConfig.apiKey);
      this.api = new APIClient(snippetConfig);

      // Check for cached config first (for instant render)
      const cachedConfig = this.storage.getConfig();
      if (cachedConfig) {
        this.config = this.mergeConfig(cachedConfig, snippetConfig);
        this.render();
      }

      // Fetch fresh config
      const configResult = await this.api.fetchConfig();
      if (configResult.success) {
        this.config = this.mergeConfig(configResult.data, snippetConfig);
        this.storage.setConfig(configResult.data);
        this.retryAfter = configResult.data.retryAfter || 300;

        // Check kill switch
        if (!this.config.enabled) {
          this.enterDormantMode();
          return false;
        }

        // Render or update
        if (!this.shadowRoot) {
          this.render();
        } else {
          this.updateStyles();
        }

        // Start config refresh interval
        this.startConfigRefresh();
      } else {
        // If no cached config and fetch failed, we can't render
        if (!cachedConfig) {
          console.error('[Horus] Failed to load config');
          return false;
        }
      }

      // Set up theme detection
      this.setupThemeDetection();

      // Set up event listeners
      this.setupGlobalEventListeners();

      // Check for existing session
      this.initializeSession();

      // Start inactivity checker
      this.startInactivityCheck();

      // Auto-open if configured
      if (this.config.autoOpen && !this.storage.get('has_opened')) {
        setTimeout(() => {
          this.open();
          this.storage.set('has_opened', true);
        }, this.config.autoOpenDelay || 5000);
      }

      // Expose public API
      window.horusDesk.open = () => this.open();
      window.horusDesk.close = () => this.close();
      window.horusDesk.destroy = () => this.destroy();
      window.horusDesk.isOpen = () => this.isOpen;

      return true;
    }

    /**
     * Merge server config with snippet overrides
     */
    mergeConfig(serverConfig, snippetConfig) {
      const merged = deepMerge({}, serverConfig);

      // Snippet overrides
      if (snippetConfig.headerTitle !== undefined) {
        merged.headerTitle = snippetConfig.headerTitle;
      }
      if (snippetConfig.welcomeMessage !== undefined) {
        merged.welcomeMessage = snippetConfig.welcomeMessage;
      }
      if (snippetConfig.position !== undefined) {
        merged.position = snippetConfig.position;
      }
      if (snippetConfig.autoOpen !== undefined) {
        merged.autoOpen = snippetConfig.autoOpen;
      }

      return merged;
    }

    /**
     * Enter dormant mode (when disabled)
     */
    enterDormantMode() {
      this.isDormant = true;
      this.unmount();

      // Start polling for re-enable
      this.dormantPollInterval = setInterval(this.pollDormant, DORMANT_POLL_INTERVAL);
    }

    /**
     * Poll for re-enable in dormant mode
     */
    async pollDormant() {
      const result = await this.api.fetchConfig();
      if (result.success && result.data.enabled) {
        // Re-enable!
        this.isDormant = false;
        clearInterval(this.dormantPollInterval);
        this.dormantPollInterval = null;

        // Re-initialize
        this.config = this.mergeConfig(result.data, window.horusDesk || {});
        this.storage.setConfig(result.data);
        this.render();
        this.setupThemeDetection();
        this.setupGlobalEventListeners();
        this.initializeSession();
        this.startInactivityCheck();
        this.startConfigRefresh();
      }
    }

    /**
     * Start config refresh interval
     */
    startConfigRefresh() {
      if (this.configRefreshInterval) {
        clearInterval(this.configRefreshInterval);
      }
      this.configRefreshInterval = setInterval(this.refreshConfig, CONFIG_REFRESH_INTERVAL);
    }

    /**
     * Refresh config from server
     */
    async refreshConfig() {
      const result = await this.api.fetchConfig();
      if (result.success) {
        // Check if disabled
        if (!result.data.enabled && this.config.enabled) {
          // Just got disabled
          this.handleDisable(result.data);
          return;
        }

        // Update config
        this.config = this.mergeConfig(result.data, window.horusDesk || {});
        this.storage.setConfig(result.data);
        this.updateStyles();
      }
    }

    /**
     * Handle widget disable
     */
    handleDisable(configData) {
      this.config.enabled = false;

      if (this.isOpen) {
        // Show disable banner
        this.showDisableBanner(configData.disableMessage || 'Chat temporarily unavailable');

        // Disable input
        const input = this.shadowRoot.querySelector('.horus-input');
        const sendBtn = this.shadowRoot.querySelector('.horus-send-btn');
        if (input) input.disabled = true;
        if (sendBtn) sendBtn.disabled = true;

        // Auto-close after 5 seconds
        setTimeout(() => {
          this.close();
          this.enterDormantMode();
        }, 5000);
      } else {
        this.enterDormantMode();
      }
    }

    /**
     * Show disable banner
     */
    showDisableBanner(message) {
      const header = this.shadowRoot.querySelector('.horus-header');
      if (!header) return;

      const banner = document.createElement('div');
      banner.className = 'horus-disable-banner';
      banner.textContent = message;
      header.parentNode.insertBefore(banner, header.nextSibling);
    }

    /**
     * Set up theme detection
     */
    setupThemeDetection() {
      if (window.matchMedia) {
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        this.isDarkMode = mediaQuery.matches;

        if (mediaQuery.addEventListener) {
          mediaQuery.addEventListener('change', this.handleThemeChange);
        } else if (mediaQuery.addListener) {
          mediaQuery.addListener(this.handleThemeChange);
        }
      }
    }

    /**
     * Handle theme change
     */
    handleThemeChange(e) {
      this.isDarkMode = e.matches;
      this.updateStyles();
    }

    /**
     * Set up global event listeners
     */
    setupGlobalEventListeners() {
      document.addEventListener('keydown', this.handleKeyDown);
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
      window.addEventListener('resize', this.handleResize);
    }

    /**
     * Initialize session
     */
    initializeSession() {
      // Check for existing valid session
      if (this.storage.isSessionValid()) {
        this.sessionId = this.storage.getSessionId();
        this.visitorData = this.storage.getVisitorData();
        this.messages = this.storage.getMessages();
        this.lastMessageTime = this.getLastMessageTime();
      } else {
        // Clear old session data
        this.storage.clear();
        this.messages = [];
      }
    }

    /**
     * Get last message timestamp
     */
    getLastMessageTime() {
      const messages = this.storage.getMessages();
      if (messages.length > 0) {
        return new Date(messages[messages.length - 1].timestamp).getTime();
      }
      return null;
    }

    /**
     * Start inactivity check
     */
    startInactivityCheck() {
      if (this.inactivityCheckInterval) {
        clearInterval(this.inactivityCheckInterval);
      }
      this.inactivityCheckInterval = setInterval(this.checkInactivity, 60000); // Check every minute
    }

    /**
     * Check for inactivity
     */
    checkInactivity() {
      if (!this.lastMessageTime || !this.isOpen) return;

      const inactiveTime = Date.now() - this.lastMessageTime;
      if (inactiveTime >= INACTIVITY_TIMEOUT) {
        this.triggerSurvey('inactivity');
      }
    }

    /**
     * Render the widget
     */
    render() {
      // Create host element
      this.hostElement = document.createElement('div');
      this.hostElement.id = 'horus-desk-widget';
      this.hostElement.style.cssText = 'position: static; display: contents;';

      // Create shadow root
      this.shadowRoot = this.hostElement.attachShadow({ mode: 'open' });

      // Create style element
      this.styleElement = document.createElement('style');
      this.styleElement.textContent = getStyles(this.config, this.isDarkMode);
      this.shadowRoot.appendChild(this.styleElement);

      // Create container
      this.container = document.createElement('div');
      this.container.className = 'horus-widget-container';
      this.shadowRoot.appendChild(this.container);

      // Render FAB
      this.renderFAB();

      // Render chat window (initially hidden)
      this.renderChatWindow();

      // Append to document
      document.body.appendChild(this.hostElement);
    }

    /**
     * Update styles (for theme changes)
     */
    updateStyles() {
      if (this.styleElement) {
        this.styleElement.textContent = getStyles(this.config, this.isDarkMode);
      }
    }

    /**
     * Render FAB button
     */
    renderFAB() {
      this.fabButton = document.createElement('button');
      this.fabButton.className = 'horus-fab horus-focusable';
      this.fabButton.setAttribute('aria-label', 'Open chat');
      this.fabButton.innerHTML = ICONS.chat;
      this.fabButton.addEventListener('click', () => this.open());
      this.container.appendChild(this.fabButton);
    }

    /**
     * Render chat window
     */
    renderChatWindow() {
      this.chatWindow = document.createElement('div');
      this.chatWindow.className = 'horus-chat-window';
      this.chatWindow.setAttribute('role', 'dialog');
      this.chatWindow.setAttribute('aria-label', 'Chat with Horus Desk');

      // Header
      const header = document.createElement('div');
      header.className = 'horus-header';
      header.innerHTML = `
        <div class="horus-header-title">
          ${ICONS.robot}
          <span>${escapeHTML(this.config.headerTitle || 'Chat with us')}</span>
        </div>
        <div class="horus-header-actions">
          <button class="horus-header-btn horus-focusable" id="horus-end-chat" aria-label="End chat">End Chat</button>
          <button class="horus-header-btn horus-focusable" id="horus-close-chat" aria-label="Close chat">${ICONS.close}</button>
        </div>
      `;
      this.chatWindow.appendChild(header);

      // Messages area
      this.messagesArea = document.createElement('div');
      this.messagesArea.className = 'horus-messages';
      this.messagesArea.setAttribute('aria-live', 'polite');
      this.chatWindow.appendChild(this.messagesArea);

      // Input area
      this.inputArea = document.createElement('div');
      this.inputArea.className = 'horus-input-area';
      this.inputArea.innerHTML = `
        <textarea 
          class="horus-input horus-focusable" 
          placeholder="Type a message..." 
          rows="1"
          aria-label="Message"
        ></textarea>
        <button class="horus-send-btn horus-focusable" aria-label="Send message">
          ${ICONS.send}
        </button>
      `;
      this.chatWindow.appendChild(this.inputArea);

      // Powered by (if enabled)
      if (this.config.showPoweredBy !== false) {
        const poweredBy = document.createElement('div');
        poweredBy.className = 'horus-powered-by';
        poweredBy.innerHTML = 'Powered by <a href="https://horusdesk.com" target="_blank" rel="noopener">Horus Desk</a>';
        this.chatWindow.appendChild(poweredBy);
      }

      this.container.appendChild(this.chatWindow);

      // Set up event listeners
      this.setupChatEventListeners();
    }

    /**
     * Set up chat window event listeners
     */
    setupChatEventListeners() {
      // Close button
      const closeBtn = this.shadowRoot.getElementById('horus-close-chat');
      if (closeBtn) {
        closeBtn.addEventListener('click', () => this.close());
      }

      // End chat button
      const endChatBtn = this.shadowRoot.getElementById('horus-end-chat');
      if (endChatBtn) {
        endChatBtn.addEventListener('click', () => this.triggerSurvey('manual'));
      }

      // Input
      const input = this.shadowRoot.querySelector('.horus-input');
      if (input) {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.sendMessage();
          }
        });

        // Auto-resize
        input.addEventListener('input', () => {
          input.style.height = 'auto';
          input.style.height = Math.min(input.scrollHeight, 100) + 'px';
        });
      }

      // Send button
      const sendBtn = this.shadowRoot.querySelector('.horus-send-btn');
      if (sendBtn) {
        sendBtn.addEventListener('click', () => this.sendMessage());
      }
    }

    /**
     * Open chat
     */
    open() {
      if (this.isOpen || !this.config) return;

      this.isOpen = true;
      this.previouslyFocusedElement = document.activeElement;

      // Hide FAB
      if (this.fabButton) {
        this.fabButton.style.display = 'none';
      }

      // Show chat window
      if (this.chatWindow) {
        this.chatWindow.classList.add('open');
      }

      // Check if we need to show pre-chat form
      const needsForm =
        this.config.captureFields &&
        this.config.captureFields.length > 0 &&
        !this.storage.isSessionValid();

      if (needsForm) {
        this.showPreChatForm();
      } else {
        // Restore messages or show welcome
        this.restoreMessages();

        // Recover any replies that were stored server-side but never
        // reached this client (lost responses, suspended tabs, etc.)
        if (this.sessionId) {
          this.syncHistoryFromServer();
        }

        // Focus input
        const input = this.shadowRoot.querySelector('.horus-input');
        if (input) {
          setTimeout(() => input.focus(), 100);
        }
      }

      // Set up focus trap
      this.setupFocusTrap();

      // Prevent body scroll on mobile
      if (window.innerWidth <= 480) {
        document.body.style.overflow = 'hidden';
      }

      // Trigger initial API call if new session
      if (this.sessionId && this.messages.length === 0) {
        this.sendToAPI('[CONVERSATION_STARTED]');
      }
    }

    /**
     * Close chat
     */
    close() {
      if (!this.isOpen) return;

      this.isOpen = false;

      // Show FAB
      if (this.fabButton) {
        this.fabButton.style.display = 'flex';
      }

      // Hide chat window
      if (this.chatWindow) {
        this.chatWindow.classList.remove('open');
      }

      // Remove focus trap
      this.removeFocusTrap();

      // Restore body scroll
      document.body.style.overflow = '';

      // Restore focus
      if (this.previouslyFocusedElement) {
        this.previouslyFocusedElement.focus();
      }
    }

    /**
     * Show pre-chat form
     */
    showPreChatForm() {
      const formOverlay = document.createElement('div');
      formOverlay.className = 'horus-form-overlay';
      formOverlay.id = 'horus-prechat-form';

      const fields = this.config.captureFields || [];
      const requiredFields = this.config.requiredFields || [];

      let formHTML = `
        <div class="horus-form-title">${escapeHTML(this.config.formTitle || "Let's connect!")}</div>
        <div class="horus-form-subtitle">${escapeHTML(this.config.formSubtitle || "We'll respond immediately")}</div>
      `;

      fields.forEach((field) => {
        const isRequired = requiredFields.includes(field);
        const label = field.charAt(0).toUpperCase() + field.slice(1);
        const type = field === 'email' ? 'email' : field === 'phone' ? 'tel' : 'text';

        formHTML += `
          <div class="horus-form-group">
            <label class="horus-form-label">
              ${escapeHTML(label)}
              ${isRequired ? '<span class="required">*</span>' : ''}
            </label>
            <input 
              type="${type}" 
              class="horus-form-input horus-focusable" 
              name="${field}"
              ${isRequired ? 'required' : ''}
              aria-required="${isRequired}"
            />
            <div class="horus-form-error" id="error-${field}" style="display:none"></div>
          </div>
        `;
      });

      formHTML += `
        <button type="submit" class="horus-form-submit horus-focusable">
          Start Chat
        </button>
      `;

      formOverlay.innerHTML = formHTML;
      this.chatWindow.appendChild(formOverlay);

      // Form submission
      formOverlay.addEventListener('submit', (e) => {
        e.preventDefault();
        this.handleFormSubmit(formOverlay);
      });

      // Focus first input
      const firstInput = formOverlay.querySelector('input');
      if (firstInput) {
        setTimeout(() => firstInput.focus(), 100);
      }
    }

    /**
     * Handle form submission
     */
    handleFormSubmit(formOverlay) {
      const inputs = formOverlay.querySelectorAll('.horus-form-input');
      const requiredFields = this.config.requiredFields || [];
      let isValid = true;
      const formData = {};

      inputs.forEach((input) => {
        const field = input.name;
        const value = input.value.trim();
        formData[field] = value;

        const errorEl = formOverlay.querySelector(`#error-${field}`);

        if (requiredFields.includes(field) && !value) {
          isValid = false;
          input.classList.add('error');
          if (errorEl) {
            errorEl.textContent = `${field.charAt(0).toUpperCase() + field.slice(1)} is required`;
            errorEl.style.display = 'block';
          }
        } else if (field === 'email' && value && !this.isValidEmail(value)) {
          isValid = false;
          input.classList.add('error');
          if (errorEl) {
            errorEl.textContent = 'Please enter a valid email';
            errorEl.style.display = 'block';
          }
        } else {
          input.classList.remove('error');
          if (errorEl) {
            errorEl.style.display = 'none';
          }
        }
      });

      if (!isValid) return;

      // Store visitor data
      this.visitorData = formData;
      this.storage.setVisitorData(formData);

      // Create session
      this.sessionId = this.storage.createSession();

      // Remove form
      formOverlay.remove();

      // Show welcome message
      this.showWelcomeMessage();

      // Focus input
      const input = this.shadowRoot.querySelector('.horus-input');
      if (input) {
        input.focus();
      }

      // Trigger initial API call
      this.sendToAPI('[CONVERSATION_STARTED]');
    }

    /**
     * Validate email
     */
    isValidEmail(email) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }

    /**
     * Show welcome message
     */
    showWelcomeMessage() {
      const welcomeMessage = this.config.welcomeMessage || 'Hi there! How can I help you today?';
      this.addMessage({
        role: 'ai',
        content: welcomeMessage,
      });
    }

    /**
     * Restore messages from storage
     */
    restoreMessages() {
      this.messagesArea.innerHTML = '';
      this.messages = this.storage.getMessages();

      if (this.messages.length === 0) {
        this.showWelcomeMessage();
      } else {
        this.messages.forEach((msg) => {
          this.renderMessage(msg);
        });
        this.scrollToBottom();
      }
    }

    /**
     * Send message
     */
    sendMessage() {
      if (this.isLoading) return;

      const input = this.shadowRoot.querySelector('.horus-input');
      if (!input) return;

      const text = input.value.trim();
      if (!text) return;

      // Check throttle
      if (this.lastSendTime && Date.now() - this.lastSendTime < 1000) {
        return;
      }
      this.lastSendTime = Date.now();

      // Clear input
      input.value = '';
      input.style.height = 'auto';

      // Add user message
      this.addMessage({
        role: 'user',
        content: text,
      });

      // Send to API
      this.sendToAPI(text);
    }

    /**
     * Send message to API
     */
    async sendToAPI(message) {
      if (this.isLoading) {
        this.pendingMessage = message;
        return;
      }

      this.isLoading = true;
      this.showTypingIndicator();
      this.updateInputState();

      // Ensure session exists
      if (!this.sessionId) {
        this.sessionId = this.storage.createSession();
      }

      const metadata = {
        url: window.location.href,
        userAgent: navigator.userAgent,
        referrer: document.referrer,
      };

      const result = await this.api.sendChat(
        this.sessionId,
        this.visitorData,
        message,
        metadata,
        (text) => this.appendStreamDelta(text)
      );

      this.hideTypingIndicator();
      this.isLoading = false;
      this.updateInputState();

      if (result.success) {
        const response = result.data;

        // Update session ID if changed
        if (response.sessionId && response.sessionId !== this.sessionId) {
          this.sessionId = response.sessionId;
          const session = this.storage.get('session') || {};
          session.id = this.sessionId;
          this.storage.set('session', session);
        }

        if (result.streamed && this.streamMessageEl) {
          // Finalize the live bubble with the authoritative final text, then
          // store the message (already rendered — no re-render needed)
          const contentEl = this.streamMessageEl.querySelector('.horus-message-content');
          if (contentEl) contentEl.innerHTML = formatAIMessage(response.message);
          this.streamMessageEl = null;
          this.streamText = '';
          this.messages = this.storage.addMessage({
            role: 'ai',
            content: response.message,
            quickReplies: response.quickReplies,
          });
          this.lastMessageTime = Date.now();
          if (response.quickReplies && response.quickReplies.length > 0) {
            this.renderQuickReplies(response.quickReplies);
          }
          this.scrollToBottom();
        } else {
          // Add AI response
          this.addMessage({
            role: 'ai',
            content: response.message,
            quickReplies: response.quickReplies,
          });
        }

        // Store escalated flag
        if (response.escalated) {
          this.lastEscalated = true;
        }
      } else {
        // Drop any partial streamed text — the history recovery below will
        // fetch the stored reply if the server still completed it
        if (this.streamMessageEl) {
          this.streamMessageEl.remove();
          this.streamMessageEl = null;
          this.streamText = '';
        }
        // Show error
        let errorMessage = 'Sorry, something went wrong. Please try again.';
        let showRetry = true;

        if (result.timeout) {
          errorMessage = 'Request timed out. Please check your connection.';
        } else if (result.error && result.error.includes('401')) {
          errorMessage = 'Configuration error. Please contact support.';
          showRetry = false;
        } else if (result.error && result.error.includes('403')) {
          errorMessage = 'Access denied. Please contact support.';
          showRetry = false;
        }

        this.showErrorBanner(errorMessage, showRetry ? message : null);

        // The server may still have processed the message and stored a reply
        // (e.g. the response was lost on a slow connection). Check for stored
        // replies shortly after — if one arrives, dismiss the error banner.
        [5000, 15000].forEach((delay) => {
          setTimeout(() => {
            this.syncHistoryFromServer().then((recovered) => {
              if (recovered) {
                const banner = this.shadowRoot.querySelector('.horus-error-banner');
                if (banner) banner.remove();
              }
            });
          }, delay);
        });
      }

      // Process pending message
      if (this.pendingMessage) {
        const pending = this.pendingMessage;
        this.pendingMessage = null;
        this.sendToAPI(pending);
      }
    }

    /**
     * Merge server messages into local message list.
     * Matches by role+content in order; local-only messages (e.g. the welcome
     * message, which is never stored server-side) are kept in place.
     * Returns { merged, added } where added = server messages missing locally.
     */
    _mergeMessages(local, server) {
      const merged = [];
      const added = [];
      let li = 0;

      for (const sm of server) {
        let found = -1;
        for (let j = li; j < local.length; j++) {
          if (local[j].role === sm.role && local[j].content === sm.content) {
            found = j;
            break;
          }
        }
        if (found >= 0) {
          for (let k = li; k <= found; k++) merged.push(local[k]);
          li = found + 1;
        } else {
          merged.push(sm);
          added.push(sm);
        }
      }
      for (let k = li; k < local.length; k++) merged.push(local[k]);

      return { merged, added };
    }

    /**
     * Sync conversation history from the server.
     * Recovers AI responses that were stored server-side but never reached
     * this client (request timeout, mobile tab suspension, network drop).
     * Returns true if new messages were recovered.
     */
    async syncHistoryFromServer() {
      if (!this.sessionId || this.isSyncingHistory) return false;
      this.isSyncingHistory = true;

      try {
        const result = await this.api.fetchHistory(this.sessionId);
        if (!result.success || !result.data || !Array.isArray(result.data.messages)) {
          return false;
        }

        const serverMessages = result.data.messages.map((m) => ({
          role: m.role === 'ai' ? 'ai' : 'user',
          content: m.content,
          timestamp: m.createdAt || getISOTimestamp(),
        }));

        const { merged, added } = this._mergeMessages(this.messages, serverMessages);

        if (added.length === 0) return false;

        this.messages = merged;
        this.storage.set('messages', merged);
        this.lastMessageTime = this.getLastMessageTime();

        // Re-render the message list if the UI is available
        if (this.messagesArea) {
          this.messagesArea.innerHTML = '';
          this.quickReplySetId++;
          for (const m of this.messages) {
            this.renderMessage(m);
          }
          this.scrollToBottom();
        }

        return true;
      } catch (e) {
        return false;
      } finally {
        this.isSyncingHistory = false;
      }
    }

    /**
     * Add message to chat
     */
    addMessage(message) {
      // Store message
      this.messages = this.storage.addMessage(message);
      this.lastMessageTime = Date.now();

      // Render message
      this.renderMessage(message);

      // Scroll to bottom
      this.scrollToBottom();
    }

    /**
     * Render a single message
     */
    renderMessage(message) {
      const messageEl = document.createElement('div');
      messageEl.className = `horus-message ${message.role}`;

      const isAI = message.role === 'ai';
      const avatar = isAI ? ICONS.robot : '';
      const sanitizedContent = isAI ? formatAIMessage(message.content) : escapeHTML(message.content);
      const time = formatTime(message.timestamp || new Date());

      messageEl.innerHTML = `
        ${isAI ? `<div class="horus-message-avatar">${avatar}</div>` : ''}
        <div>
          <div class="horus-message-content">${sanitizedContent}</div>
          <div class="horus-message-time">${time}</div>
        </div>
      `;

      this.messagesArea.appendChild(messageEl);

      // Render quick replies if present
      if (isAI && message.quickReplies && message.quickReplies.length > 0) {
        this.renderQuickReplies(message.quickReplies);
      }
    }

    /**
     * Render quick replies
     */
    renderQuickReplies(replies) {
      this.quickReplySetId++;
      const setId = this.quickReplySetId;

      const container = document.createElement('div');
      container.className = 'horus-quick-replies';
      container.dataset.setId = setId;

      replies.forEach((reply) => {
        const btn = document.createElement('button');
        btn.className = 'horus-quick-reply horus-focusable';
        btn.textContent = reply;
        btn.addEventListener('click', () => {
          // Hide this quick reply set
          container.remove();

          // Send as user message
          this.addMessage({
            role: 'user',
            content: reply,
          });

          // Send to API
          this.sendToAPI(reply);
        });
        container.appendChild(btn);
      });

      this.messagesArea.appendChild(container);
    }

    /**
     * Append a streamed text delta to the live AI bubble (created on first
     * delta, replacing the typing indicator)
     */
    appendStreamDelta(text) {
      if (!this.streamMessageEl) {
        this.hideTypingIndicator();
        this.streamText = '';
        const el = document.createElement('div');
        el.className = 'horus-message ai';
        el.innerHTML = `
          <div class="horus-message-avatar">${ICONS.robot}</div>
          <div>
            <div class="horus-message-content"></div>
            <div class="horus-message-time">${formatTime(new Date())}</div>
          </div>
        `;
        this.messagesArea.appendChild(el);
        this.streamMessageEl = el;
      }
      this.streamText += text;
      const contentEl = this.streamMessageEl.querySelector('.horus-message-content');
      if (contentEl) contentEl.innerHTML = formatAIMessage(this.streamText);
      this.scrollToBottom();
    }

    /**
     * Show typing indicator
     */
    showTypingIndicator() {
      this.typingIndicator = document.createElement('div');
      this.typingIndicator.className = 'horus-typing';
      this.typingIndicator.innerHTML = `
        <div class="horus-message-avatar">${ICONS.robot}</div>
        <div class="horus-typing-indicator">
          <span class="horus-typing-dot"></span>
          <span class="horus-typing-dot"></span>
          <span class="horus-typing-dot"></span>
        </div>
      `;
      this.messagesArea.appendChild(this.typingIndicator);
      this.scrollToBottom();
    }

    /**
     * Hide typing indicator
     */
    hideTypingIndicator() {
      if (this.typingIndicator) {
        this.typingIndicator.remove();
        this.typingIndicator = null;
      }
    }

    /**
     * Update input state
     */
    updateInputState() {
      const input = this.shadowRoot.querySelector('.horus-input');
      const sendBtn = this.shadowRoot.querySelector('.horus-send-btn');

      if (input) {
        input.disabled = this.isLoading;
      }
      if (sendBtn) {
        sendBtn.disabled = this.isLoading;
      }
    }

    /**
     * Show error banner
     */
    showErrorBanner(message, retryMessage) {
      // Remove existing error banner
      const existing = this.shadowRoot.querySelector('.horus-error-banner');
      if (existing) existing.remove();

      const banner = document.createElement('div');
      banner.className = 'horus-error-banner';

      let html = `${ICONS.warning} <span>${escapeHTML(message)}</span>`;

      if (retryMessage) {
        html += `<button class="horus-retry-btn horus-focusable">Retry</button>`;
      }

      banner.innerHTML = html;

      if (retryMessage) {
        banner.querySelector('.horus-retry-btn').addEventListener('click', () => {
          banner.remove();
          this.sendToAPI(retryMessage);
        });
      }

      const header = this.shadowRoot.querySelector('.horus-header');
      if (header) {
        header.parentNode.insertBefore(banner, header.nextSibling);
      }

      // Auto-remove after 10 seconds
      setTimeout(() => {
        banner.remove();
      }, 10000);
    }

    /**
     * Scroll to bottom of messages
     */
    scrollToBottom() {
      if (this.messagesArea) {
        this.messagesArea.scrollTop = this.messagesArea.scrollHeight;
      }
    }

    /**
     * Trigger survey
     */
    triggerSurvey(reason) {
  		if (this.storage.wasSurveyShown()) return;
  		if (this._surveyOpen) return;  // Prevent stacking if already open
		
  		this.surveyReason = reason;
  		this._surveyOpen = true;
  		this.showSurveyModal();
	}

    /**
     * Show survey modal
     */
    showSurveyModal() {
      const overlay = document.createElement('div');
      overlay.className = 'horus-survey-overlay';
      overlay.id = 'horus-survey-modal';

      const showEscalationQuestion = this.lastEscalated === true;

      overlay.innerHTML = `
        <div class="horus-survey-modal" role="dialog" aria-label="Feedback Survey">
          <div class="horus-survey-title">How was your experience?</div>
          
          <div class="horus-survey-question">
            <label class="horus-survey-label">Was Horus helpful?</label>
            <div class="horus-survey-stars" data-question="helpful">
              ${[1, 2, 3, 4, 5].map((i) => `<button class="horus-survey-star horus-focusable" data-value="${i}" aria-label="${i} stars">${ICONS.starOutline}</button>`).join('')}
            </div>
          </div>
          
          <div class="horus-survey-question">
            <label class="horus-survey-label">Was Horus easy to understand?</label>
            <div class="horus-survey-stars" data-question="understand">
              ${[1, 2, 3, 4, 5].map((i) => `<button class="horus-survey-star horus-focusable" data-value="${i}" aria-label="${i} stars">${ICONS.starOutline}</button>`).join('')}
            </div>
          </div>
          
          ${showEscalationQuestion ? `
          <div class="horus-survey-question">
            <label class="horus-survey-label">Could this have been resolved without human help?</label>
            <div class="horus-survey-toggle">
              <button class="horus-survey-toggle-btn horus-focusable" data-value="yes">Yes</button>
              <button class="horus-survey-toggle-btn horus-focusable" data-value="no">No</button>
            </div>
          </div>
          ` : ''}
          
          <div class="horus-survey-question">
            <label class="horus-survey-label">Additional comments (optional)</label>
            <textarea class="horus-survey-textarea horus-focusable" maxlength="250" placeholder="Tell us more..."></textarea>
            <div class="horus-survey-char-count">0 / 250</div>
          </div>
          
          <div class="horus-survey-actions">
            <button class="horus-survey-btn horus-survey-btn-secondary horus-focusable" id="horus-survey-skip">Skip</button>
            <button class="horus-survey-btn horus-survey-btn-primary horus-focusable" id="horus-survey-submit">Submit Feedback</button>
          </div>
        </div>
      `;

      this.shadowRoot.appendChild(overlay);

      // Survey data
      const surveyData = {
        helpfulRating: 0,
        understandRating: 0,
        couldResolveWithoutHuman: null,
        comment: '',
      };

      // Star ratings
      overlay.querySelectorAll('.horus-survey-stars').forEach((starContainer) => {
        const question = starContainer.dataset.question;
        const stars = starContainer.querySelectorAll('.horus-survey-star');

        stars.forEach((star, index) => {
          star.addEventListener('click', () => {
            const value = index + 1;
            surveyData[question === 'helpful' ? 'helpfulRating' : 'understandRating'] = value;

            stars.forEach((s, i) => {
              s.classList.toggle('active', i < value);
              s.innerHTML = i < value ? ICONS.star : ICONS.starOutline;
            });
          });
        });
      });

      // Toggle buttons
      overlay.querySelectorAll('.horus-survey-toggle-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          overlay.querySelectorAll('.horus-survey-toggle-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          surveyData.couldResolveWithoutHuman = btn.dataset.value === 'yes';
        });
      });

      // Character count
      const textarea = overlay.querySelector('.horus-survey-textarea');
      const charCount = overlay.querySelector('.horus-survey-char-count');
      textarea.addEventListener('input', () => {
        surveyData.comment = textarea.value;
        charCount.textContent = `${textarea.value.length} / 250`;
      });

      // Skip button
      overlay.querySelector('#horus-survey-skip').addEventListener('click', () => {
        this.closeSurvey(overlay, false);
      });

      // Submit button
      overlay.querySelector('#horus-survey-submit').addEventListener('click', async () => {
        if (surveyData.helpfulRating === 0 || surveyData.understandRating === 0) {
          // Show validation
          return;
        }

        // Submit survey
        await this.api.submitSurvey({
          sessionId: this.sessionId,
          ...surveyData,
        });

        this.closeSurvey(overlay, true);
      });

      // Show modal
      requestAnimationFrame(() => {
        overlay.classList.add('open');
      });

      // Focus first star
      const firstStar = overlay.querySelector('.horus-survey-star');
      if (firstStar) {
        setTimeout(() => firstStar.focus(), 100);
      }

      // Close on backdrop click
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          this.closeSurvey(overlay, false);
        }
      });
    }

    /**
     * Close survey modal
     */
    closeSurvey(overlay, submitted) {
	  this._surveyOpen = false;
      overlay.classList.remove('open');

      setTimeout(() => {
        overlay.remove();
      }, 300);

      // Mark survey shown
      this.storage.markSurveyShown();

      if (submitted) {
        this.showToast('Thank you for your feedback!');
      }

      // Clear session and close widget
      setTimeout(() => {
        this.storage.clear();
        this.close();
        this.sessionId = null;
        this.messages = [];
        this.visitorData = {};
      }, submitted ? 2000 : 0);
    }

    /**
     * Show toast notification
     */
    showToast(message) {
      const toast = document.createElement('div');
      toast.className = 'horus-toast';
      toast.textContent = message;
      this.shadowRoot.appendChild(toast);

      requestAnimationFrame(() => {
        toast.classList.add('show');
      });

      setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
      }, 2000);
    }

    /**
     * Set up focus trap
     */
    setupFocusTrap() {
      this.updateFocusableElements();

      this.focusTrapHandler = (e) => {
        if (e.key !== 'Tab') return;

        const firstElement = this.focusableElements[0];
        const lastElement = this.focusableElements[this.focusableElements.length - 1];

        if (e.shiftKey && document.activeElement === firstElement) {
          e.preventDefault();
          lastElement.focus();
        } else if (!e.shiftKey && document.activeElement === lastElement) {
          e.preventDefault();
          firstElement.focus();
        }
      };

      this.chatWindow.addEventListener('keydown', this.focusTrapHandler);
    }

    /**
     * Remove focus trap
     */
    removeFocusTrap() {
      if (this.focusTrapHandler) {
        this.chatWindow.removeEventListener('keydown', this.focusTrapHandler);
        this.focusTrapHandler = null;
      }
    }

    /**
     * Update focusable elements list
     */
    updateFocusableElements() {
      this.focusableElements = Array.from(
        this.chatWindow.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.disabled && el.offsetParent !== null);
    }

    /**
     * Handle keyboard events
     */
    handleKeyDown(e) {
      if (e.key === 'Escape' && this.isOpen) {
        this.close();
      }
    }

    /**
     * Handle visibility change
     */
    handleVisibilityChange() {
      if (!document.hidden) {
        // Refresh config when page becomes visible
        this.refreshConfig();

        // Mobile browsers suspend tabs — responses that arrived while we were
        // in the background are lost, so re-sync history when we wake up.
        if (this.isOpen) {
          this.syncHistoryFromServer();
        }
      }
    }

    /**
     * Handle window resize
     */
    handleResize() {
      // Ensure input stays visible on mobile when keyboard opens
      if (this.isOpen && window.innerWidth <= 480) {
        const input = this.shadowRoot.querySelector('.horus-input');
        if (input && document.activeElement === input) {
          setTimeout(() => {
            input.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }, 300);
        }
      }
    }

    /**
     * Unmount widget (for kill switch)
     */
    unmount() {
      this.close();

      if (this.hostElement) {
        this.hostElement.remove();
        this.hostElement = null;
      }

      this.shadowRoot = null;
      this.container = null;
      this.fabButton = null;
      this.chatWindow = null;

      // Clear intervals
      if (this.configRefreshInterval) {
        clearInterval(this.configRefreshInterval);
        this.configRefreshInterval = null;
      }
      if (this.inactivityCheckInterval) {
        clearInterval(this.inactivityCheckInterval);
        this.inactivityCheckInterval = null;
      }

      // Abort pending requests
      if (this.api) {
        this.api.abortAll();
      }

      // Remove event listeners
      document.removeEventListener('keydown', this.handleKeyDown);
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
      window.removeEventListener('resize', this.handleResize);

      // Remove theme listener
      if (window.matchMedia) {
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        if (mediaQuery.removeEventListener) {
          mediaQuery.removeEventListener('change', this.handleThemeChange);
        } else if (mediaQuery.removeListener) {
          mediaQuery.removeListener(this.handleThemeChange);
        }
      }
    }

    /**
     * Destroy widget completely
     */
    destroy() {
      this.unmount();

      // Clear storage
      if (this.storage) {
        this.storage.clear();
      }

      // Clear dormant polling
      if (this.dormantPollInterval) {
        clearInterval(this.dormantPollInterval);
        this.dormantPollInterval = null;
      }

      // Remove from window
      delete window.horusDesk;
    }
  }

  // ============================================
  // INITIALIZATION
  // ============================================

  let widgetInstance = null;

  function initWidget() {
    if (widgetInstance) return;

    widgetInstance = new HorusDeskWidget();
    widgetInstance.init();
  }

  // Auto-initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWidget);
  } else {
    // DOM already loaded
    initWidget();
  }

  // Also try initializing after a short delay in case script is loaded async
  setTimeout(() => {
    if (!widgetInstance) {
      initWidget();
    }
  }, 100);

  // Return public API
  return {
    version: WIDGET_VERSION,
    init: initWidget,
  };
});
