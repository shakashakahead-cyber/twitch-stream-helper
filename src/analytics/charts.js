// Small, dependency-free SVG charts. Null points break lines and are never plotted as zero.
const SVG = "http://www.w3.org/2000/svg";
const COLORS = ["#a78bfa", "#4dd4bb", "#f4be64"];
const number = value => typeof value === "number" && Number.isFinite(value);
function svgNode(tag, attributes = {}, text = "") {
    const node = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (text) node.textContent = text;
    return node;
}
export function chart(container, { points, series, kind = "line", label, empty, stacked = false, gapMs = Infinity, onSelect }) {
    container.replaceChildren();
    const legend = document.createElement("div"); legend.className = "chart-legend";
    series.forEach((item, index) => {
        const entry = document.createElement("span"), dot = document.createElement("i");
        dot.style.background = COLORS[index % COLORS.length];
        entry.append(dot, document.createTextNode(item.label)); legend.append(entry);
    });
    container.append(legend);
    if (!points.some(point => series.some(item => number(point[item.key])))) {
        const state = document.createElement("p"); state.className = "chart-empty"; state.textContent = empty;
        container.append(state); return;
    }
    const width = 720, height = 252, left = 48, right = 20, top = 16, bottom = 42;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const highest = Math.max(1, ...points.map(point => stacked
        ? series.reduce((n, item) => n + (number(point[item.key]) ? point[item.key] : 0), 0)
        : Math.max(0, ...series.map(item => number(point[item.key]) ? point[item.key] : 0))));
    const step = Math.max(1, 10 ** Math.floor(Math.log10(highest)));
    const ceiling = Math.ceil(highest / step) * step;
    const dated = points.every(p => number(p.time)) && kind === "line";
    const minTime = dated ? Math.min(...points.map(p => p.time)) : 0;
    const maxTime = dated ? Math.max(...points.map(p => p.time)) : 0;
    const x = index => dated && maxTime > minTime ? left + (points[index].time - minTime) / (maxTime - minTime) * plotWidth
        : left + (index + 0.5) / points.length * plotWidth;
    const y = value => top + plotHeight * (1 - value / ceiling);
    const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": label });
    for (let i = 0; i <= 4; i++) {
        const value = ceiling * i / 4, row = y(value);
        svg.append(svgNode("line", { x1: left, x2: width - right, y1: row, y2: row, class: "grid-line" }));
        svg.append(svgNode("text", { x: left - 9, y: row + 4, "text-anchor": "end", class: "axis-label" },
            new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)));
    }
    const marks = new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]);
    for (const index of marks) svg.append(svgNode("text", { x: x(index), y: height - 12, "text-anchor": index === 0 ? "start" : index === points.length - 1 ? "end" : "middle", class: "axis-label" }, points[index].label));
    const tip = document.createElement("div"); tip.className = "chart-tooltip"; tip.hidden = true; tip.setAttribute("role", "status");
    const showTip = point => { tip.textContent = point.tooltip || point.label; tip.hidden = false; };
    const hideTip = () => { tip.hidden = true; };
    const barWidth = Math.min(42, plotWidth / points.length * 0.7);
    series.forEach((item, seriesIndex) => {
        const color = COLORS[seriesIndex % COLORS.length];
        if (kind === "line") {
            let path = "", connected = false, previous = null;
            points.forEach((point, index) => {
                if (!number(point[item.key])) { connected = false; return; }
                if (previous !== null && point.time - previous > gapMs) connected = false;
                path += `${connected ? "L" : "M"}${x(index)},${y(point[item.key])} `;
                connected = true; previous = point.time;
            });
            svg.append(svgNode("path", { d: path, fill: "none", stroke: color, "stroke-width": 2.5, "stroke-linejoin": "round" }));
        }
        points.forEach((point, index) => {
            const value = point[item.key];
            if (!number(value)) return;
            const offset = stacked ? series.slice(0, seriesIndex).reduce((n, previous) => n + (point[previous.key] || 0), 0) : 0;
            const shape = kind === "line" ? svgNode("circle", { cx: x(index), cy: y(value), r: 4, fill: color })
                : svgNode("rect", { x: x(index) - barWidth / 2 + (stacked ? 0 : seriesIndex * barWidth / series.length),
                    y: y(value + offset), width: stacked ? barWidth : barWidth / series.length,
                    height: Math.max(1, y(0) - y(value)), rx: 2, fill: color });
            shape.setAttribute("tabindex", "0");
            shape.setAttribute("aria-label", point.tooltip || `${point.label}: ${value}`);
            shape.append(svgNode("title", {}, point.tooltip || `${point.label}: ${value}`));
            shape.addEventListener("mouseenter", () => showTip(point));
            shape.addEventListener("focus", () => showTip(point));
            shape.addEventListener("mouseleave", hideTip); shape.addEventListener("blur", hideTip);
            if (onSelect && point.streamId) {
                shape.style.cursor = "pointer";
                shape.addEventListener("click", () => onSelect(point.streamId));
                shape.addEventListener("keydown", event => { if (event.key === "Enter") onSelect(point.streamId); });
            }
            svg.append(shape);
        });
    });
    container.append(svg, tip);
}
