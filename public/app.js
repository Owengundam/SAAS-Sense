const headers = {
  "content-type": "application/json",
  "x-shop-domain": "atelier-home.myshopify.com",
  authorization: "Bearer demo-token-a",
};

const stateLabels = {
  IN_STOCK: "In stock",
  OUT_OF_STOCK: "Out of stock",
  UNCERTAIN: "Needs review",
  SOURCE_ERROR: "Source failed",
};

const formatTime = (value) => value
  ? new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value))
  : "Never";

function badge(value, stale) {
  const cls = stale ? "stale" : value?.toLowerCase().replaceAll("_", "-") || "pending";
  return `<span class="state ${cls}"><i></i>${stale ? "Stale" : stateLabels[value] || "Awaiting baseline"}</span>`;
}

function latestFor(sourceId, observations) {
  return observations.find((item) => item.source_id === sourceId);
}

function render(data) {
  const factual = data.sources.filter((item) => item.lastState).length;
  const uncertain = data.observations.filter((item) => !item.factual).length;
  document.querySelector("#metrics").innerHTML = `
    <article><span class="metric-label">Monitored links</span><strong>${data.tenant.sourceUsage}<small> / ${data.tenant.sourceLimit}</small></strong><span class="metric-note">pilot quota</span></article>
    <article><span class="metric-label">Confirmed baselines</span><strong>${factual}</strong><span class="metric-note">safe to compare</span></article>
    <article><span class="metric-label">Checks this month</span><strong>${data.tenant.monthlyCheckUsage}<small> / ${data.tenant.monthlyCheckLimit}</small></strong><span class="metric-note">server enforced</span></article>
    <article><span class="metric-label">Review items</span><strong>${uncertain}</strong><span class="metric-note">never auto-alerted</span></article>`;

  document.querySelector("#sources").innerHTML = data.sources.map((source) => {
    const latest = latestFor(source.id, data.observations);
    return `<tr>
      <td><strong>${source.productTitle}</strong><span>${source.sku}</span></td>
      <td>${badge(source.lastState, source.stale)}</td>
      <td><span class="evidence">${latest?.reason || "Run first check to establish a baseline"}</span></td>
      <td><time>${formatTime(source.lastCheckedAt)}</time></td>
      <td><button class="icon-btn check-one" data-id="${source.id}" title="Run check">↻</button></td>
    </tr>`;
  }).join("");

  const review = data.observations.filter((item) => !item.factual).slice(0, 4);
  document.querySelector("#queue").innerHTML = review.length
    ? review.map((item) => `<div class="queue-item"><span>${item.product_title}</span><strong>${stateLabels[item.state]}</strong><small>${item.reason}</small></div>`).join("")
    : `<div class="empty"><span>✓</span><p>No uncertain checks yet.</p></div>`;
  document.querySelectorAll(".check-one").forEach((button) => button.addEventListener("click", () => runChecks(button.dataset.id)));
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function showNotice(message, kind = "ok") {
  const notice = document.querySelector("#notice");
  notice.textContent = message;
  notice.className = `notice ${kind}`;
  notice.hidden = false;
  setTimeout(() => { notice.hidden = true; }, 4500);
}

async function load() {
  render(await api("/api/dashboard"));
}

async function runChecks(sourceId) {
  const button = document.querySelector("#run-checks");
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    await api("/api/checks/run", { method: "POST", body: JSON.stringify(sourceId ? { sourceId } : {}) });
    await load();
    showNotice(sourceId ? "Source checked. Evidence log updated." : "Watchlist checked. No failed extraction was treated as a stock event.");
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    button.disabled = false;
    button.innerHTML = "Run all checks <span>↗</span>";
  }
}

document.querySelector("#run-checks").addEventListener("click", () => runChecks());
const dialog = document.querySelector("#add-dialog");
document.querySelector("#show-add").addEventListener("click", () => dialog.showModal());
document.querySelector("#close-dialog").addEventListener("click", () => dialog.close());
document.querySelector("#add-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  values.matchTerms = values.matchTerms.split(",").map((item) => item.trim()).filter(Boolean);
  try {
    await api("/api/sources", { method: "POST", body: JSON.stringify(values) });
    dialog.close();
    event.currentTarget.reset();
    await load();
    showNotice("Source added. It will remain unconfirmed until its first successful check.");
  } catch (error) {
    showNotice(error.message, "error");
  }
});

load().catch((error) => showNotice(error.message, "error"));
