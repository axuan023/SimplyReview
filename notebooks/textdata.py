import json
from pathlib import Path
import pandas as pd

# settings
categories = ["All_Beauty", "Appliances", "Video_Games"]

per_star = 2000       # reviews per star level, per category
min_total = 200       # same as 01_backtest.py
max_words = 200       # skip very long reviews

root = Path(__file__).resolve().parent.parent
data_dir = root / "data" / "raw"
out_dir = root / "data" / "processed"


# load reviews with their text
def load_reviews(category):
    rows = []

    with open(data_dir / f"{category}.jsonl", encoding="utf-8") as file:
        for line in file:
            review = json.loads(line)

            text = (review.get("title", "") + ". " + review.get("text", "")).strip()

            rows.append((
                review["parent_asin"],
                int(review["rating"]),
                text
            ))

    return pd.DataFrame(rows, columns=["product", "rating", "text"])


def main():
    samples = []

    for category in categories:
        df = load_reviews(category)

        # leave out the back-test products, so the model never sees them
        counts = df.groupby("product").size()
        test_ids = counts[counts >= min_total].index
        df = df[~df["product"].isin(test_ids)]

        # skip empty and very long reviews
        words = df["text"].str.split().str.len()
        df = df[(words >= 3) & (words <= max_words)]

        # same number of reviews at each star level
        for star in range(1, 6):
            reviews = df[df["rating"] == star]
            count = min(per_star, len(reviews))

            sample = reviews.sample(count, random_state=0)
            sample = sample.assign(category=category)
            samples.append(sample)

        print(f"{category}: done")

    data = pd.concat(samples).sample(frac=1, random_state=0)

    # save
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / "text_reviews.csv"
    data[["category", "rating", "text"]].to_csv(out_file, index=False)

    print(f"\nSaved {len(data):,} reviews to data/processed/text_reviews.csv")
    print(data["rating"].value_counts().sort_index().to_string())


if __name__ == "__main__":
    main()