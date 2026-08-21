export const SPIRIT_FAMILIES = [
  "Whiskey", "Gin", "Rum", "Tequila", "Mezcal", "Vodka", "Cognac", "Brandy",
  "Amaro", "Liqueur", "Bitters", "Mixer"
];

export const SPIRIT_TYPES: Record<string, string[]> = {
  Whiskey: ["Bourbon", "Rye", "Scotch", "Irish", "Corn whiskey", "Tennessee", "Canadian", "Japanese", "Blended", "Wheat whiskey"],
  Gin: ["London Dry", "Old Tom", "Contemporary", "Plymouth", "Navy Strength"],
  Rum: ["White", "Gold", "Dark", "Spiced", "Agricole", "Overproof"],
  Tequila: ["Blanco", "Reposado", "Añejo", "Extra Añejo", "Cristalino"],
  Mezcal: ["Joven", "Reposado", "Añejo"],
  Vodka: ["Neutral", "Potato", "Wheat", "Flavored"],
  Cognac: ["VS", "VSOP", "XO"],
  Brandy: ["American", "Armagnac", "Calvados", "Pisco"],
  Amaro: ["Bitter", "Alpine", "Fernet"],
  Liqueur: ["Orange", "Herbal", "Coffee", "Cream", "Fruit"],
  Bitters: ["Aromatic", "Orange", "Celery", "Chocolate"],
  Mixer: ["Soda", "Juice", "Syrup", "Tonic", "Vermouth"]
};

export const BEER_STYLES = [
  "IPA", "Double IPA", "Pale Ale", "Lager", "Pilsner", "Sour", "Gose", "Berliner Weisse",
  "Stout", "Porter", "Wheat", "Hefeweizen", "Belgian", "Saison", "Amber", "Brown",
  "Barleywine", "Kölsch", "Bock", "Cider", "Seltzer", "Other"
];

export const BASE_INGREDIENTS = [
  "Barley", "Corn", "Rye", "Wheat", "Oats", "Rice", "Agave", "Molasses",
  "Cane", "Grapes", "Potatoes", "Fruit", "Other"
];

export const FLAVOR_OPTIONS = [
  "Peat", "Smoke", "Vanilla", "Oak", "Caramel", "Honey", "Spice", "Pepper",
  "Cinnamon", "Citrus", "Apple", "Cherry", "Dark fruit", "Dried fruit",
  "Tropical", "Floral", "Nutty", "Chocolate", "Coffee", "Malt", "Bread",
  "Roast", "Tart", "Funk", "Pine", "Earth", "Mineral", "Leather", "Brine"
];

export { parseList, parseTagInput, serializeList } from "../../src/catalog";
