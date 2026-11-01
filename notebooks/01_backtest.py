
import json
from pathlib import Path
import pandas as pd

# settings
categories = {
    # dataset name: names amazon shows in the page's category links
    "All_Beauty": ["Beauty & Personal Care", "Beauty"],
    "Appliances": ["Appliances"],
    "Video_Games": ["Video Games"],
}

first_k = 10
min_total = 200
strengths = [1, 2, 5, 10, 20, 50]

root = Path(__file__).resolve().parent.parent
data_dir = root / "data" / "raw"
results_dir = root / "results"


# download reviews
def download_reviews(category):
    file = data_dir / f"{category}.jsonl"

    if file.exists():
        return file

    from huggingface_hub import hf_hub_download

    data_dir.mkdir(parents=True, exist_ok=True)

    print(f"Downloading {category} reviews...")

    path = hf_hub_download(
        repo_id="McAuley-Lab/Amazon-Reviews-2023",
        filename=f"raw/review_categories/{category}.jsonl",
        repo_type="dataset",
        local_dir=data_dir / "hf"
    )

    Path(path).replace(file)

    return file


# load product ratings
def load_reviews(path):
    rows = []

    with open(path, encoding="utf-8") as file:
        for line in file:
            review = json.loads(line)

            rows.append((
                review["parent_asin"],
                float(review["rating"]),
                review["timestamp"]
            ))

    return pd.DataFrame(rows, columns=["product", "rating", "time"])


# predictions using the category average
def category_predictions(data, strength, category_stars, category_good):
    stars = (data["raw_stars"] * first_k + strength * category_stars) / (first_k + strength)
    good = (data["raw_good"] * first_k + strength * category_good) / (first_k + strength)

    return stars, good


# test one category
def backtest(category):
    print(f"\n========== {category} ==========")

    df = load_reviews(download_reviews(category))

    print(f"Loaded {len(df):,} reviews")
    print(f"Products: {df['product'].nunique():,}")

    # find products with enough reviews
    counts = df.groupby("product").size()
    test_ids = counts[counts >= min_total].index

    print(f"Testing {len(test_ids):,} products")

    # category average from other products
    others = df[~df["product"].isin(test_ids)]

    category_stars = others["rating"].mean()
    category_good = (others["rating"] >= 4).mean()

    # test each product
    results = []

    test_data = df[df["product"].isin(test_ids)]

    for product, group in test_data.groupby("product"):
        group = group.sort_values("time")

        early = group["rating"].iloc[:first_k]

        results.append({
            "product": product,
            "total_reviews": len(group),
            "true_stars": group["rating"].mean(),
            "true_good": (group["rating"] >= 4).mean(),
            "raw_stars": early.mean(),
            "raw_good": (early >= 4).mean()
        })

    res = pd.DataFrame(results)

    # split into tune and check halves
    tune = res.sample(frac=0.5, random_state=0)
    check = res.drop(tune.index)

    # find the best number of pretend reviews
    rows = []

    for strength in strengths:
        stars, good = category_predictions(tune, strength, category_stars, category_good)

        rows.append({
            "Pretend reviews": strength,
            "Star Error": abs(stars - tune["true_stars"]).mean(),
            "Good Rating Error (%)": 100 * abs(good - tune["true_good"]).mean()
        })

    tuning = pd.DataFrame(rows)

    print(f"\nTuning on {len(tune):,} products\n")
    print(tuning.round(3).to_string(index=False))

    best = int(tuning.loc[tuning["Good Rating Error (%)"].idxmin(), "Pretend reviews"])

    # check on products the tuning never saw
    stars, good = category_predictions(check, best, category_stars, category_good)

    raw_star_error = abs(check["raw_stars"] - check["true_stars"]).mean()
    raw_good_error = 100 * abs(check["raw_good"] - check["true_good"]).mean()
    best_star_error = abs(stars - check["true_stars"]).mean()
    best_good_error = 100 * abs(good - check["true_good"]).mean()

    star_change = 100 * (1 - best_star_error / raw_star_error)
    good_change = 100 * (1 - best_good_error / raw_good_error)

    print(f"\nBest: {best} pretend reviews. Checked on the other {len(check):,} products:")
    print(f"  Stars:           {raw_star_error:.3f} -> {best_star_error:.3f} ({star_change:.0f}% less error)")
    print(f"  Good experience: {raw_good_error:.2f} -> {best_good_error:.2f} points ({good_change:.0f}% less error)")

    # save results
    results_dir.mkdir(exist_ok=True)
    res.to_csv(results_dir / f"backtest_{category}.csv", index=False)

    summary = {
        "category": category,
        "products": len(res),
        "strength": best,
        "star_change": round(star_change, 1),
        "good_change": round(good_change, 1)
    }

    prior = {
        "names": categories[category],
        "stars": round(float(category_stars), 4),
        "good": round(float(category_good), 4),
        "strength": best
    }

    return summary, prior


def main():
    summaries = []
    priors = {}

    for category in categories:
        summary, prior = backtest(category)

        summaries.append(summary)
        priors[category] = prior

    # all categories together
    print("\n========== Summary ==========\n")
    print(pd.DataFrame(summaries).to_string(index=False))

    total = sum(summary["products"] for summary in summaries)
    print(f"\nTotal products tested: {total:,}")

    # save the numbers for the chrome extension
    prior_file = root / "extension" / "prior.js"
    prior_file.write_text(
        "// Made by notebooks/01_backtest.py. Re-run the script to update.\n"
        f"window.SIMPLYREVIEW_PRIORS = {json.dumps(priors, indent=2)};\n"
    )

    print("\nSaved extension/prior.js")


if __name__ == "__main__":
    main()
