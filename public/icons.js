// Flat geometric monochrome SVG icon library for Pond (24x24 grid, crisp flat strokes).
(function () {
  const PATHS = {
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    branch: '<path d="M6 3v10a5 5 0 0 0 5 5h7"/><path d="m15 15 3 3-3 3"/><circle cx="6" cy="3.5" r="0.5"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    pin: '<path d="M9 4h6l-1 6 3 3v1H7v-1l3-3-1-6Z"/><path d="M12 14v6"/>',
    pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
    alert: '<path d="M12 9v4m0 4h.01M10.3 3.8 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0Z"/>',
    send: '<path d="M12 19V5"/><path d="m5.5 11.5 6.5-6.5 6.5 6.5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4"/>',
    moon: '<path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11Z"/>',
    bell: '<path d="M6 9a6 6 0 1 1 12 0c0 5 2 6.5 2 6.5H4s2-1.5 2-6.5Z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    shield: '<path d="M12 3 4 6.5V12c0 5 3.4 8.3 8 9.5 4.6-1.2 8-4.5 8-9.5V6.5L12 3Z"/>',
    zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>',
    handwave: '<path d="M18.5 11V6a1.5 1.5 0 0 0-3 0v4"/><path d="M15.5 10V4.5a1.5 1.5 0 0 0-3 0V10"/><path d="M12.5 10V5.5a1.5 1.5 0 0 0-3 0V11"/><path d="M9.5 11V8a1.5 1.5 0 0 0-3 0v6a6 6 0 0 0 12 0v-3Z"/><path d="M19.5 3.5c1.2 1 2 2.4 2.2 4"/><path d="M3.3 8.5c.2-1.4.9-2.7 1.9-3.7"/>',
    sparkles: '<circle cx="12" cy="12" r="2.5"/><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M18.4 5.6l-2.1 2.1m-8.6 8.6-2.1 2.1"/>',
    sliders: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="11" cy="18" r="2" fill="currentColor" stroke="none"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
    eye: '<path d="M2 12s3.8-6.5 10-6.5S22 12 22 12s-3.8 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>',
    plug: '<path d="M9 3v5m6-5v5M7 8h10v3a5 5 0 0 1-10 0V8Zm5 8v5"/>',
    activity: '<path d="M3 12h4l2.5-7 5 14 2.5-7H21"/>',
    play: '<polygon points="7 5 19 12 7 19 7 5" fill="currentColor" stroke="none"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13"/>',
    file: '<path d="M6 3h8l4 4v14H6V3Z"/><path d="M14 3v4h4"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18"/>',
    link: '<path d="M10 13a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7L11 6.3"/><path d="M14 11a4 4 0 0 0-5.7 0L5.5 13.8a4 4 0 0 0 5.7 5.7l1.8-1.8"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.2" fill="currentColor" stroke="none"/>',
    bulb: '<path d="M9 18h6m-5 3h4M12 3a6 6 0 0 0-3.5 10.9c.7.6 1 1.3 1 2.1h5c0-.8.3-1.5 1-2.1A6 6 0 0 0 12 3Z"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6L20 9"/><path d="M20 4v5h-5"/>',
    layout: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m5 0h5"/>',
    cpu: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M9 3v4m6-4v4M9 17v4m6-4v4M3 9h4m-4 6h4m10-6h4m-4 6h4"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
    dot: '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
  };

  function flatIcon(name, size = 16, cls = '') {
    const body = PATHS[name] || PATHS.dot;
    return `<svg class="ui-icon${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  }

  function hydrateIcons(root = document) {
    root.querySelectorAll('[data-icon]').forEach((el) => {
      const name = el.getAttribute('data-icon');
      const size = Number(el.getAttribute('data-size')) || 16;
      el.innerHTML = flatIcon(name, size);
    });
  }

  window.flatIcon = flatIcon;
  window.hydrateIcons = hydrateIcons;
})();
