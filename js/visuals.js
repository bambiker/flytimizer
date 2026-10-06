// Altitude tape and compass rose visuals.

// ---------------------------------------------------------------
// Visuals: altitude tape + compass rose (SVG, theme-matched)
// ---------------------------------------------------------------

export var VIZ_COLORS = {
  accent: '#ff8a34',   // outbound
  accent2: '#4fd1c5',  // return / wind
  ink: '#e7ecf6',
  muted: '#8d9ab8',
  line: '#324066',
  panel: '#17223a',
  danger: '#ff5a5a'
};

// Keeps the SVG diagrams in step with the page's light/dark theme,
// which otherwise follows the OS/browser preference via CSS alone.
export function refreshVizTheme(){
  var light = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  if (light){
    VIZ_COLORS.accent = '#d9670f';
    VIZ_COLORS.accent2 = '#0e8c7f';
    VIZ_COLORS.ink = '#172037';
    VIZ_COLORS.muted = '#58658a';
    VIZ_COLORS.line = '#c7cfe0';
    VIZ_COLORS.panel = '#eef1f8';
    VIZ_COLORS.danger = '#c93030';
    WIND_COLORS = ['#3355cc', '#0e8c7f', '#b8790a'];
  } else {
    VIZ_COLORS.accent = '#ff8a34';
    VIZ_COLORS.accent2 = '#4fd1c5';
    VIZ_COLORS.ink = '#e7ecf6';
    VIZ_COLORS.muted = '#8d9ab8';
    VIZ_COLORS.line = '#324066';
    VIZ_COLORS.panel = '#17223a';
    VIZ_COLORS.danger = '#ff5a5a';
    WIND_COLORS = ['#7c9cff', '#4fd1c5', '#ffd166'];
  }
}

export function polarToXY(cx, cy, r, deg){
  var rad = (deg) * Math.PI / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

export var WIND_COLORS = ['#7c9cff', '#4fd1c5', '#ffd166']; // 30m, 80m, 120m

// Draws a line from the center out to `length`, with a small triangular
// arrowhead at the tip pointing in the direction of travel, plus an
// optional short text label placed just past the tip.
export function drawArrow(cx, cy, length, deg, color, width, label, labelOffset){
  var tip = polarToXY(cx, cy, length, deg);
  var back = polarToXY(cx, cy, length - 9, deg);
  var leftDeg = deg - 8, rightDeg = deg + 8;
  var headBase = length - 9;
  var lp = polarToXY(cx, cy, headBase, leftDeg);
  var rp = polarToXY(cx, cy, headBase, rightDeg);

  var svg = '<line x1="' + cx + '" y1="' + cy + '" x2="' + back.x + '" y2="' + back.y + '" stroke="' + color + '" stroke-width="' + width + '" stroke-linecap="round"/>' +
    '<polygon points="' + tip.x + ',' + tip.y + ' ' + lp.x + ',' + lp.y + ' ' + rp.x + ',' + rp.y + '" fill="' + color + '"/>';

  if (label){
    var lpt = polarToXY(cx, cy, length + (labelOffset || 14), deg);
    svg += '<text x="' + lpt.x + '" y="' + (lpt.y + 3) + '" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="' + color + '">' + label + '</text>';
  }
  return svg;
}

export function renderCompassRose(droneDeg, windPoints){
  var el = document.getElementById('compassRose');
  if (!el) return;
  refreshVizTheme();

  var w = 220, h = 300;
  var cx = w / 2, cy = 120, r = 76;

  var ring = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + VIZ_COLORS.line + '" stroke-width="1.5"/>' +
             '<circle cx="' + cx + '" cy="' + cy + '" r="2" fill="' + VIZ_COLORS.line + '"/>';

  var labels = [0, 90, 180, 270];
  var labelText = ['0/360', '90', '180', '270'];
  var ticks = '';
  for (var i = 0; i < labels.length; i++){
    var p1 = polarToXY(cx, cy, r, labels[i]);
    var p2 = polarToXY(cx, cy, r - 8, labels[i]);
    var pt = polarToXY(cx, cy, r + 15, labels[i]);
    ticks += '<line x1="' + p1.x + '" y1="' + p1.y + '" x2="' + p2.x + '" y2="' + p2.y + '" stroke="' + VIZ_COLORS.muted + '" stroke-width="1.5"/>';
    ticks += '<text x="' + pt.x + '" y="' + (pt.y + 3) + '" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="' + VIZ_COLORS.muted + '">' + labelText[i] + '</text>';
  }

  // Wind arrows first (shorter, so the drone heading arrow sits on top
  // and always stays readable even if directions overlap). Open-Meteo
  // reports wind direction as where it blows FROM (met. convention);
  // we flip it 180 deg here so the arrow points where it's blowing
  // TO, which lines up intuitively against the drone's heading arrow
  // (same direction = tailwind, opposite = headwind).
  var windArrows = '';
  var windFlowDeg = [];
  var radii = [r * 0.45, r * 0.62, r * 0.8];
  for (var j = 0; j < windPoints.length; j++){
    var color = WIND_COLORS[j % WIND_COLORS.length];
    windFlowDeg[j] = (windPoints[j].wd + 180) % 360;
    windArrows += drawArrow(cx, cy, radii[j], windFlowDeg[j], color, 2, null, 0);
  }

  var droneArrow = drawArrow(cx, cy, r - 4, droneDeg, VIZ_COLORS.ink, 2.5, null, 0);

  // Legend: one row per series with its actual heading, since color
  // alone on an overlapping compass is hard to read at a glance. The
  // wind rows show the same "blowing to" degree as their arrow.
  var legendRows = [
    { color: VIZ_COLORS.ink, text: 'drone heading ' + droneDeg.toFixed(0) + '\u00B0' }
  ];
  var windLabels = ['wind 30m \u2192 ', 'wind 80m \u2192 ', 'wind 120m \u2192 '];
  for (var k = 0; k < windPoints.length; k++){
    legendRows.push({
      color: WIND_COLORS[k % WIND_COLORS.length],
      text: windLabels[k] + windFlowDeg[k].toFixed(0) + '\u00B0'
    });
  }

  var legendTop = h - (legendRows.length * 18) - 6;
  var legend = '<g font-family="JetBrains Mono, monospace" font-size="11">';
  for (var m = 0; m < legendRows.length; m++){
    var ly = legendTop + m * 18;
    legend += '<line x1="6" y1="' + ly + '" x2="20" y2="' + ly + '" stroke="' + legendRows[m].color + '" stroke-width="3" stroke-linecap="round"/>';
    legend += '<text x="26" y="' + (ly + 4) + '" fill="' + VIZ_COLORS.muted + '">' + legendRows[m].text + '</text>';
  }
  legend += '</g>';

  var svg =
    '<svg viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Compass showing the drone\'s outbound heading and the direction each wind is blowing toward, at 20, 80 and 120 meters">' +
      '<text x="' + cx + '" y="14" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="' + VIZ_COLORS.muted + '">HEADING (OUT) vs WIND FLOW</text>' +
      ring + ticks + windArrows + droneArrow + legend +
    '</svg>';

  el.innerHTML = svg;
}
