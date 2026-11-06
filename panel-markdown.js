/**
 * Minimal, dependency-free Markdown for node-chat bubbles.
 *
 * Everything is escaped before any tag is added, so model output can never
 * inject HTML. Supported: fenced code (with a copy button), inline code, bold,
 * headings, bullet/ordered lists, blockquotes, http(s) links, line breaks.
 */
(function (global) {
  "use strict";

  var ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

  function escapeHtml(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, function (ch) {
      return ENTITIES[ch];
    });
  }

  function inline(escaped) {
    return escaped
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
  }

  function renderText(text) {
    var lines = text.split(/\r?\n/);
    var html = [];
    var list = null;
    var paragraph = [];

    function flushParagraph() {
      if (paragraph.length === 0) return;
      html.push("<p>" + paragraph.map(inline).join("<br>") + "</p>");
      paragraph = [];
    }

    function closeList() {
      if (!list) return;
      html.push("</" + list + ">");
      list = null;
    }

    for (var index = 0; index < lines.length; index += 1) {
      var line = lines[index];
      if (!line.trim()) {
        flushParagraph();
        closeList();
        continue;
      }
      var heading = /^\s*(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        flushParagraph();
        closeList();
        var size = [18, 16, 14.5, 13][heading[1].length - 1];
        html.push('<div class="md-h" style="font-size:' + size + 'px">' + inline(escapeHtml(heading[2])) + "</div>");
        continue;
      }
      var bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      if (bullet) {
        flushParagraph();
        if (list !== "ul") {
          closeList();
          html.push("<ul>");
          list = "ul";
        }
        html.push("<li>" + inline(escapeHtml(bullet[1])) + "</li>");
        continue;
      }
      var ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ordered) {
        flushParagraph();
        if (list !== "ol") {
          closeList();
          html.push("<ol>");
          list = "ol";
        }
        html.push("<li>" + inline(escapeHtml(ordered[1])) + "</li>");
        continue;
      }
      var quote = /^\s*>\s?(.*)$/.exec(line);
      if (quote) {
        flushParagraph();
        closeList();
        html.push("<blockquote>" + inline(escapeHtml(quote[1])) + "</blockquote>");
        continue;
      }
      closeList();
      paragraph.push(escapeHtml(line));
    }

    flushParagraph();
    closeList();
    return html.join("");
  }

  function renderMarkdown(text) {
    var source = typeof text === "string" ? text : "";
    var fence = /```([^\n`]*)\r?\n([\s\S]*?)```/g;
    var html = [];
    var last = 0;
    var match;
    while ((match = fence.exec(source)) !== null) {
      if (match.index > last) html.push(renderText(source.slice(last, match.index)));
      html.push(
        '<pre><button type="button" class="md-copy" title="复制代码">复制</button><code>'
          + escapeHtml(match[2].replace(/\n$/, ""))
          + "</code></pre>",
      );
      last = match.index + match[0].length;
    }
    if (last < source.length) html.push(renderText(source.slice(last)));
    return html.join("");
  }

  global.__nodeChatMarkdown = { escapeHtml: escapeHtml, renderMarkdown: renderMarkdown };
})(typeof window !== "undefined" ? window : globalThis);
