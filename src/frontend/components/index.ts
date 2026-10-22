// Clean barrel export for all frontend components grouped by domain.
// For app-level consumers (page.tsx) only: components inside this folder import
// each other DIRECTLY (relative paths) so the barrel never forms an import cycle.

// Chat UI
export * from "./chat/ChatThread";
export * from "./chat/MessageBubble";
export * from "./chat/Composer";
export * from "./chat/MessageQueue";
export * from "./chat/TypingDots";
export * from "./chat/Markdown";
export * from "./chat/ModelBadge";

// Catalog & Discovery
export * from "./catalog/ProductGrid";
export * from "./catalog/ProductCard";
export * from "./catalog/MenuList";
export * from "./catalog/FoodRestaurantCard";
export * from "./catalog/DineoutRestaurantCard";
export * from "./catalog/DineoutSlotPicker";
export * from "./catalog/ScenesEventCard";
export * from "./catalog/ScenesShowPicker";
export * from "./catalog/CompareCard";
export * from "./catalog/CompareBar";
export * from "./catalog/RevealList";

// Cart & Budget
export * from "./cart/CartPanel";
export * from "./cart/FoodCartPanel";
export * from "./cart/CartLineRow";
export * from "./cart/BudgetMeter";
export * from "./cart/MacroMeter";
export * from "./cart/ProposalBar";
export * from "./cart/SwapBar";

// Navigation & Brand
export * from "./navigation/TopNav";
export * from "./navigation/AddressPicker";
export * from "./navigation/AccountMenu";
export * from "./navigation/PoweredBy";
export * from "./navigation/CreateAddressModal";
export * from "./navigation/ThemeToggle";
export * from "./navigation/SpikeMark";
export * from "./navigation/Badge";
export * from "./navigation/PriceTag";
export * from "./navigation/EmptyState";

// Specialized Features & Menus
export * from "./features/ConciergeToolsMenu";
export * from "./features/CookMode";
export * from "./features/OrderTracker";
export * from "./features/PaymentModal";
export * from "./features/HistoryMenu";
export * from "./features/SharedBasketBanner";
export * from "./features/ShareBasketButton";
export * from "./features/UsualsBoard";
