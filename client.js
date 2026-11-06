window.__ModuleLoader__.load({
  id: 'deepseekbaby',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // Optional-module guard: a DSH build without these client modules must
    // report a diagnostic instead of throwing during the client bundle's import
    // (which would blank the page). `inject` below still declares both, so a
    // missing service is handled by the host too; this only makes the failure
    // readable in the browser console.
    const CLIENT_DEPS = [
      ['@deepseek-ai/dsh-client-ui-layout', 'slots'],
      ['@deepseek-ai/dsh-client-locale', 'locale'],
    ];
    const missing = [];
    for (const [module, service] of CLIENT_DEPS) {
      try {
        require(module);
      } catch (error) {
        missing.push(service + ' (' + module + ')');
      }
    }

    const NS = 'nodeChat';
    const PAGE = '/node-chat';
    const DEFAULT_RIGHT = 20;
    const DEFAULT_BOTTOM = 210;
    const HANDLE_HEIGHT = 28;
    const MIN_WIDTH = 360;
    const MIN_HEIGHT = 260;
    const EDGE = 8;

    const zh = {
      'entry.open': 'deepseekbaby',
      'entry.close': '收起 deepseekbaby',
      'frame.title': 'deepseekbaby',
      'frame.drag': '按住拖动窗口，双击复位',
      'frame.reset': '复位窗口位置',
      'frame.resize': '拖动调整大小，双击恢复默认',
    };

    const en = {
      'entry.open': 'deepseekbaby',
      'entry.close': 'Close deepseekbaby',
      'frame.title': 'deepseekbaby',
      'frame.drag': 'Drag to move, double-click to reset',
      'frame.reset': 'Reset window position',
      'frame.resize': 'Drag to resize, double-click to reset',
    };

    // DeepSeek's whale mark, used twice: the big one is the brand blue and the
    // small one trails behind in a lighter tint, like a parent and its calf.
    const WHALE_PATH = 'M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45';
    const WHALE_BIG = 'translate(0.3 1.6) scale(0.62)';
    const WHALE_SMALL = 'translate(13.8 13.2) scale(0.4)';

    function WhalePair(props) {
      const size = props.size ?? 24;
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none', 'aria-hidden': true,
        style: { display: 'block' },
      },
        h('g', { transform: WHALE_BIG }, h('path', { fill: props.big ?? '#4D6BFE', d: WHALE_PATH })),
        h('g', { transform: WHALE_SMALL }, h('path', { fill: props.small ?? '#93ABFF', d: WHALE_PATH })),
      );
    }

    // 把窗口限制在视口内，避免拖出屏幕后拿不回来。
    function clampPos(left, top, size) {
      const maxLeft = Math.max(0, window.innerWidth - size.width);
      const maxTop = Math.max(0, window.innerHeight - size.height);
      return {
        left: Math.min(Math.max(0, left), maxLeft),
        top: Math.min(Math.max(0, top), maxTop),
      };
    }

    function NodeChatLauncher(props) {
      const { t } = props;
      const [open, setOpen] = React.useState(false);
      const [hover, setHover] = React.useState(false);
      const [pos, setPos] = React.useState(null);
      const [dragging, setDragging] = React.useState(false);
      const [resizing, setResizing] = React.useState(false);
      const [size, setSize] = React.useState(null);
      const frameRef = React.useRef(null);
      const dragRef = React.useRef(null);
      const resizeRef = React.useRef(null);

      React.useEffect(() => {
        if (!open) return undefined;
        const onMessage = (event) => {
          if (event.origin !== window.location.origin) return;
          if (event.data && event.data.type === 'node-chat/close') setOpen(false);
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
      }, [open]);

      // 拖动过程中 iframe 会截获指针事件，所以统一在 window 上监听，并临时禁用 iframe 命中。
      React.useEffect(() => {
        if (!dragging && !resizing) return undefined;
        const onMove = (event) => {
          if (resizing) {
            const resize = resizeRef.current;
            if (!resize) return;
            // 左上角保持不动，右下角随指针走；上限是视口剩余空间。
            const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - EDGE - resize.left);
            const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - EDGE - resize.top);
            setSize({
              width: Math.min(Math.max(MIN_WIDTH, resize.width + event.clientX - resize.x), maxWidth),
              height: Math.min(Math.max(MIN_HEIGHT, resize.height + event.clientY - resize.y), maxHeight),
            });
            return;
          }
          const drag = dragRef.current;
          if (!drag) return;
          setPos(clampPos(event.clientX - drag.offsetX, event.clientY - drag.offsetY, drag));
        };
        const onEnd = () => {
          dragRef.current = null;
          resizeRef.current = null;
          setDragging(false);
          setResizing(false);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onEnd);
        window.addEventListener('pointercancel', onEnd);
        window.addEventListener('blur', onEnd);
        return () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onEnd);
          window.removeEventListener('pointercancel', onEnd);
          window.removeEventListener('blur', onEnd);
        };
      }, [dragging, resizing]);

      // 视口变化后重新夹紧，避免窗口跑到可视区域外。
      React.useEffect(() => {
        if (!pos) return undefined;
        const onResize = () => {
          const el = frameRef.current;
          if (!el) return;
          const rect = el.getBoundingClientRect();
          setPos(clampPos(rect.left, rect.top, { width: rect.width, height: rect.height }));
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, [pos, size]);

      const startDrag = (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        const el = frameRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        dragRef.current = {
          offsetX: event.clientX - rect.left,
          offsetY: event.clientY - rect.top,
          width: rect.width,
          height: rect.height,
        };
        setPos(clampPos(rect.left, rect.top, rect));
        setDragging(true);
        event.preventDefault();
      };

      const startResize = (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        event.stopPropagation();
        const el = frameRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const base = clampPos(rect.left, rect.top, rect);
        const nextSize = { width: rect.width, height: rect.height };
        setPos(base);
        setSize(nextSize);
        resizeRef.current = {
          x: event.clientX,
          y: event.clientY,
          left: base.left,
          top: base.top,
          width: nextSize.width,
          height: nextSize.height,
        };
        setResizing(true);
        event.preventDefault();
      };

      const resetSize = () => {
        resizeRef.current = null;
        setResizing(false);
        setSize(null);
      };

      const resetPos = () => {
        dragRef.current = null;
        resizeRef.current = null;
        setDragging(false);
        setResizing(false);
        if (size) {
          const left = window.innerWidth - DEFAULT_RIGHT - size.width;
          const top = window.innerHeight - DEFAULT_BOTTOM - size.height;
          setPos(clampPos(left, top, size));
          return;
        }
        setPos(null);
      };

      const label = open ? t('entry.close') : t('entry.open');

      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          onClick: () => setOpen((value) => !value),
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          'aria-label': label,
          'aria-expanded': open ? true : false,
          title: label,
          style: {
            position: 'fixed',
            right: 20,
            bottom: 148,
            zIndex: 2,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 46,
            height: 46,
            padding: 0,
            border: '1px solid rgba(255, 255, 255, 0.18)',
            borderRadius: 999,
            background: 'linear-gradient(135deg, #6C8CFF, #3B54E4)',
            color: 'var(--dsw-alias-label-primary)',
            boxShadow: open
              ? '0 0 0 2px rgba(255, 255, 255, 0.92), 0 10px 28px rgba(0, 0, 0, 0.32)'
              : hover
                ? '0 10px 28px rgba(0, 0, 0, 0.32)'
                : '0 8px 24px rgba(0, 0, 0, 0.28)',
            transform: hover ? 'translateY(-1px) scale(1.04)' : 'none',
            cursor: 'pointer',
            pointerEvents: 'auto',
            transition: 'transform 140ms ease, box-shadow 140ms ease',
          },
        }, h(WhalePair, { size: 30, big: '#FFFFFF', small: '#C6D5FF' })),
        open
          ? h('div', {
            ref: frameRef,
            style: {
              position: 'fixed',
              ...(pos ? { left: pos.left, top: pos.top } : { right: DEFAULT_RIGHT, bottom: DEFAULT_BOTTOM }),
              zIndex: 3,
              display: 'flex',
              flexDirection: 'column',
              ...(size
                ? { width: size.width, height: size.height }
                : { width: 'min(900px, calc(100vw - 40px))', height: 'min(620px, calc(100vh - 250px))' }),
              overflow: 'hidden',
              border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: 16,
              background: 'var(--dsw-alias-bg-overlay)',
              boxShadow: '0 18px 48px rgba(0, 0, 0, 0.36)',
              pointerEvents: 'auto',
            },
          },
          h('div', {
            onPointerDown: startDrag,
            onDoubleClick: resetPos,
            title: t('frame.drag'),
            style: {
              flex: '0 0 auto',
              height: HANDLE_HEIGHT,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              padding: '0 6px 0 12px',
              borderBottom: '1px solid var(--dsw-alias-border-l1)',
              color: 'var(--dsw-alias-label-secondary)',
              fontFamily: 'inherit',
              fontSize: 12,
              userSelect: 'none',
              WebkitUserSelect: 'none',
              touchAction: 'none',
              cursor: dragging ? 'grabbing' : 'grab',
            },
          },
          h('span', {
            style: { display: 'inline-flex', alignItems: 'center', gap: 6, opacity: 0.85, pointerEvents: 'none' },
          },
          h('span', {
            style: { width: 8, height: 8, borderRadius: 999, background: 'var(--dsw-alias-brand-primary)' },
          }),
          'deepseekbaby'),
          h('button', {
            type: 'button',
            onPointerDown: (event) => event.stopPropagation(),
            onDoubleClick: (event) => event.stopPropagation(),
            onClick: resetPos,
            title: t('frame.reset'),
            'aria-label': t('frame.reset'),
            style: {
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              lineHeight: 1,
              padding: '2px 6px',
              borderRadius: 6,
              cursor: 'pointer',
            },
          }, '↺')),
          h('iframe', {
            src: PAGE,
            title: t('frame.title'),
            style: {
              display: 'block',
              flex: '1 1 0%',
              minHeight: 0,
              width: '100%',
              border: 'none',
              background: 'var(--dsw-alias-bg-base)',
              pointerEvents: dragging || resizing ? 'none' : 'auto',
            },
          }),
          h('div', {
            onPointerDown: startResize,
            onDoubleClick: resetSize,
            title: t('frame.resize'),
            'aria-hidden': true,
            style: {
              position: 'absolute',
              right: 0,
              bottom: 0,
              zIndex: 1,
              width: 18,
              height: 18,
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'flex-end',
              padding: 2,
              color: 'var(--dsw-alias-label-secondary)',
              opacity: resizing ? 0.9 : 0.55,
              cursor: 'nwse-resize',
              touchAction: 'none',
              userSelect: 'none',
              WebkitUserSelect: 'none',
            },
          },
          h('svg', {
            viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none', 'aria-hidden': true,
            style: { display: 'block' },
          },
          h('path', {
            d: 'M15 6 6 15M15 10.5 10.5 15',
            stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
          }))))
          : null,
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        if (missing.length) {
          console.error(
            '[deepseekbaby] 客户端依赖缺失：' + missing.join('、')
            + '（缺 slots 则浮层按钮不出现，缺 locale 则按钮文案退回键名）',
          );
        }
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'deepseekbaby: dictionaries');
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'deepseekbaby',
          order: 32,
          locale: NS,
        }, (props) => h(NodeChatLauncher, { t: props.t || t })));
      },
    };
  },
});
