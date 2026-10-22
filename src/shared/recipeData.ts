// Shared recipe ingredients dictionary for deterministic ingredient resolution.
// Provides staple ingredient lists for popular dishes so ingredient ordering
// never drops items even when LLM output lacks formatting.

export const DEFAULT_DISH_INGREDIENTS: Record<string, string[]> = {
  "chicken gravy": [
    "chicken",
    "onions",
    "tomatoes",
    "ginger garlic paste",
    "garam masala",
    "cooking oil",
    "coriander",
  ],
  "chicken curry": [
    "chicken",
    "onions",
    "tomatoes",
    "ginger garlic paste",
    "garam masala",
    "cooking oil",
    "coriander",
  ],
  "chicken biryani": [
    "chicken",
    "basmati rice",
    "biryani masala",
    "onions",
    "ginger garlic paste",
    "curd",
    "fresh mint",
  ],
  "paneer butter masala": [
    "paneer",
    "butter",
    "tomatoes",
    "fresh cream",
    "onions",
    "ginger garlic paste",
    "kasuri methi",
  ],
  "egg curry": [
    "eggs",
    "onions",
    "tomatoes",
    "ginger garlic paste",
    "garam masala",
    "cooking oil",
  ],
  "masala dosa": [
    "dosa batter",
    "potatoes",
    "onions",
    "mustard seeds",
    "green chillies",
    "curry leaves",
  ],
  "veg pulao": [
    "basmati rice",
    "mixed vegetables",
    "onions",
    "cumin seeds",
    "ghee",
    "garam masala",
  ],
  "pasta arrabiata": [
    "pasta",
    "pasta sauce",
    "garlic",
    "olive oil",
    "chilli flakes",
    "cheese",
  ],
  "chole bhature": [
    "kabuli chana",
    "maida",
    "onions",
    "tomatoes",
    "chole masala",
    "cooking oil",
  ],
  "palak paneer": [
    "paneer",
    "palak spinach",
    "onions",
    "tomatoes",
    "ginger garlic paste",
    "fresh cream",
  ],
  "poha": [
    "poha",
    "onions",
    "potatoes",
    "peanuts",
    "mustard seeds",
    "curry leaves",
  ],
  "vegetable upma": [
    "sooji rava",
    "mixed vegetables",
    "mustard seeds",
    "green chillies",
    "ginger",
    "ghee",
  ],
  "dal tadka": [
    "toor dal",
    "tomatoes",
    "onions",
    "garlic",
    "cumin seeds",
    "ghee",
  ],
  "maggi": [
    "maggi noodles",
    "butter",
    "cheese slice",
    "green peas",
  ],
};

/** Match a user text or dish name against known recipes and return staple ingredients. */
export function getDishIngredients(queryOrDish: string): string[] {
  const q = queryOrDish.toLowerCase().trim();
  for (const [dish, ingredients] of Object.entries(DEFAULT_DISH_INGREDIENTS)) {
    if (q.includes(dish) || dish.includes(q)) {
      return ingredients;
    }
  }
  // Substring / keyword fuzzy matches
  if (q.includes("biryani")) return DEFAULT_DISH_INGREDIENTS["chicken biryani"];
  if (q.includes("gravy") || q.includes("curry")) {
    return q.includes("egg")
      ? DEFAULT_DISH_INGREDIENTS["egg curry"]
      : DEFAULT_DISH_INGREDIENTS["chicken gravy"];
  }
  if (q.includes("paneer")) return DEFAULT_DISH_INGREDIENTS["paneer butter masala"];
  if (q.includes("dosa")) return DEFAULT_DISH_INGREDIENTS["masala dosa"];
  if (q.includes("pulao") || q.includes("rice")) return DEFAULT_DISH_INGREDIENTS["veg pulao"];
  if (q.includes("pasta")) return DEFAULT_DISH_INGREDIENTS["pasta arrabiata"];
  if (q.includes("chole")) return DEFAULT_DISH_INGREDIENTS["chole bhature"];
  if (q.includes("poha")) return DEFAULT_DISH_INGREDIENTS["poha"];
  if (q.includes("maggi") || q.includes("noodles")) return DEFAULT_DISH_INGREDIENTS["maggi"];

  // Fallback: extract the dish name as main item plus kitchen essentials
  const cleaned = q
    .replace(/\b(order|cook|recipe|ingredients|for|make|please|with|me|add|all|the|required|items)\b/gi, "")
    .trim();
  if (cleaned.length > 2) {
    return [cleaned, "onions", "tomatoes", "cooking oil", "garam masala"];
  }
  return ["chicken", "onions", "tomatoes", "cooking oil", "spices"];
}
