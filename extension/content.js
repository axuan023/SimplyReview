// SimplyReview
// re-scores amazon ratings using the prior from prior.js

(() => {

  // used when the category isn't known (the 3b1b rule)
  const fallback = {
    category: null,
    stars: 3,
    good: 0.5,
    strength: 2
  };


  // read the product's category links, like "Video Games > Accessories"
  function readCategories() {
    const links = document.querySelectorAll(
      "#wayfinding-breadcrumbs_feature_div a, #wayfinding-breadcrumbs_container a"
    );

    const names = [];
    for (const link of links) {
      names.push(link.textContent.trim().toLowerCase());
    }

    return names;
  }


  // pick the prior that matches the page's category
  function pickPrior() {
    const priors = window.SIMPLYREVIEW_PRIORS || {};
    const pageNames = readCategories();

    for (const category in priors) {
      const prior = priors[category];

      for (const name of prior.names) {
        if (pageNames.includes(name.toLowerCase())) {
          return { category, ...prior };
        }
      }
    }

    return fallback;
  }

  let prior = fallback;


  // read total number of ratings
  function readTotal() {
    const elements = document.querySelectorAll(
      '[data-hook="total-review-count"], #acrCustomerReviewText'
    );

    for (const element of elements) {
      const digits = element.textContent.replace(/[,.\s]/g, "");
      const match = digits.match(/(\d+)/);

      if (match) {
        return parseInt(match[1]);
      }
    }

    return null;
  }


  // read average stars
  function readAverage() {
    const elements = document.querySelectorAll(
      '[data-hook="rating-out-of-text"], #acrPopover, [data-hook="average-star-rating"]'
    );

    for (const element of elements) {
      const text = (element.getAttribute("title") || "") + " " + element.textContent;
      const match = text.match(/(\d[.,]?\d?)\s*out of\s*5/i);

      if (match) {
        return parseFloat(match[1].replace(",", "."));
      }
    }

    return null;
  }


  // read percent of ratings at each star level
  function readBreakdown() {
    const percents = {};

    // labels like "68 percent of reviews have 5 stars"
    for (const element of document.querySelectorAll("[aria-label], [title]")) {
      const label = element.getAttribute("aria-label") || element.getAttribute("title") || "";
      const match = label.match(/(\d{1,3})\s*percent of reviews have\s*([1-5])\s*star/i);

      if (match && percents[match[2]] === undefined) {
        percents[match[2]] = parseInt(match[1]);
      }
    }

    // text like "5 star 68%"
    const table = document.querySelector(
      '#histogramTable, [data-hook="histogram"], .histogram, #cm_cr_dp_d_rating_histogram'
    );

    if (table) {
      const text = table.innerText || table.textContent;
      const pattern = /([1-5])\s*stars?\D{0,40}?(\d{1,3})\s*%/gi;

      for (const match of text.matchAll(pattern)) {
        if (percents[match[1]] === undefined) {
          percents[match[1]] = parseInt(match[2]);
        }
      }
    }

    if (Object.keys(percents).length === 5) {
      return percents;
    }

    return null;
  }


  // log of the gamma function
  function logGamma(x) {
    const c = [
      76.18009172947146, -86.50532032941677, 24.01409824083091,
      -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5
    ];

    let y = x;
    let tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);

    let series = 1.000000000190015;
    for (const value of c) {
      y += 1;
      series += value / y;
    }

    return -tmp + Math.log(2.5066282746310005 * series / x);
  }


  // helper for the beta distribution
  function betaFraction(a, b, x) {
    const tiny = 1e-300;

    let c = 1;
    let d = 1 - (a + b) * x / (a + 1);
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;

    let result = d;

    for (let m = 1; m <= 2000; m++) {
      // even step
      let step = m * (b - m) * x / ((a - 1 + 2 * m) * (a + 2 * m));
      d = 1 + step * d;
      c = 1 + step / c;
      if (Math.abs(d) < tiny) d = tiny;
      if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      result *= d * c;

      // odd step
      step = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 1 + 2 * m));
      d = 1 + step * d;
      c = 1 + step / c;
      if (Math.abs(d) < tiny) d = tiny;
      if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;

      const change = d * c;
      result *= change;

      if (Math.abs(change - 1) < 3e-12) break;
    }

    return result;
  }


  // chance a beta(a, b) value is below x
  function betaCdf(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;

    const front = Math.exp(
      logGamma(a + b) - logGamma(a) - logGamma(b)
      + a * Math.log(x) + b * Math.log(1 - x)
    );

    if (x < (a + 1) / (a + b + 2)) {
      return front * betaFraction(a, b, x) / a;
    }

    return 1 - front * betaFraction(b, a, 1 - x) / b;
  }


  // value where betaCdf reaches p
  function betaQuantile(p, a, b) {
    let low = 0;
    let high = 1;

    for (let i = 0; i < 60; i++) {
      const middle = (low + high) / 2;

      if (betaCdf(middle, a, b) < p) {
        low = middle;
      } else {
        high = middle;
      }
    }

    return (low + high) / 2;
  }


  // score the product
  function score(total, percents) {

    // percents to counts
    const counts = {};
    for (let star = 1; star <= 5; star++) {
      counts[star] = Math.round(percents[star] / 100 * total);
    }

    const n = counts[1] + counts[2] + counts[3] + counts[4] + counts[5];

    // good = 4 or 5 stars
    const good = counts[4] + counts[5];
    const bad = n - good;

    // pretend reviews from a typical product
    const m = prior.strength;
    const priorGood = m * prior.good;
    const priorBad = m * (1 - prior.good);

    const chanceGood = (good + priorGood) / (n + m);

    // 90% range
    const low = betaQuantile(0.05, good + priorGood, bad + priorBad);
    const high = betaQuantile(0.95, good + priorGood, bad + priorBad);

    // adjusted stars
    let starTotal = 0;
    for (let star = 1; star <= 5; star++) {
      starTotal += star * counts[star];
    }

    const adjustedStars = (starTotal + m * prior.stars) / (n + m);

    return { n, good, bad, chanceGood, low, high, adjustedStars };
  }


  // show the box on the page
  function showBox(result, average) {
    if (document.getElementById("simplyreview-badge")) return;

    const percent = (x) => `${Math.round(x * 100)}%`;
    const raw = result.n > 0 ? result.good / result.n : 0;

    // show a decimal when the range is very narrow
    let range = `${percent(result.low)}–${percent(result.high)}`;

    if (percent(result.low) === percent(result.high)) {
      range = `${(result.low * 100).toFixed(1)}–${(result.high * 100).toFixed(1)}%`;
    }

    const box = document.createElement("div");
    box.id = "simplyreview-badge";

    box.style.cssText = `
      margin: 8px 0;
      padding: 10px 12px;
      border: 1px solid #c7c7c7;
      border-radius: 8px;
      background: #f7fafa;
      color: #0f1111;
      font: 14px/1.4 Arial, sans-serif;
      max-width: 360px;
    `;

    let compared = "No category data yet, using the basic rule.";
    if (prior.category) {
      compared = `Compared with typical ${prior.category.replace(/_/g, " ")} products.`;
    }

    let amazon = "";
    if (average) {
      amazon = `<span style="color:#565959">(Amazon shows ${average})</span>`;
    }

    box.innerHTML = `
      <div style="font-weight:bold; margin-bottom:4px">SimplyReview</div>

      <div>
        <b>${percent(result.chanceGood)}</b> chance of a good experience
        <span style="color:#565959">(likely ${range})</span>
      </div>

      <div>
        Adjusted rating: <b>${result.adjustedStars.toFixed(2)}</b> / 5 ${amazon}
      </div>

      <div style="color:#565959; font-size:12px; margin-top:4px">
        ${result.good.toLocaleString()} of ${result.n.toLocaleString()} ratings are 4–5 stars
        (${percent(raw)} raw). ${compared}
      </div>
    `;

    // put it under amazon's stars
    const anchor = document.querySelector("#averageCustomerReviews, #acrPopover");

    if (anchor && anchor.parentElement) {
      anchor.parentElement.insertBefore(box, anchor.nextSibling);
      return;
    }

    // otherwise pin it in the corner
    box.style.position = "fixed";
    box.style.right = "16px";
    box.style.bottom = "16px";
    box.style.zIndex = "99999";
    box.style.boxShadow = "0 2px 8px rgba(0, 0, 0, 0.2)";
    document.body.appendChild(box);
  }


  // run (retry while the page loads)
  let tries = 0;

  function run() {
    const total = readTotal();
    const percents = readBreakdown();

    if (total && percents) {
      prior = pickPrior();
      const result = score(total, percents);

      console.log("[SimplyReview]", { total, percents, ...result });
      showBox(result, readAverage());
      return;
    }

    tries += 1;

    if (tries < 10) {
      setTimeout(run, 1000);
    } else {
      console.log("[SimplyReview] No star breakdown found.", { total, percents });
    }
  }

  // for testing
  window.__simplyReview = { score, betaQuantile };

  run();

})();