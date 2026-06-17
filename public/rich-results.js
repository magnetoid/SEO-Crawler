// Google Rich Results feature requirements, hand-authored from Google's
// structured-data documentation (developers.google.com/search/docs/appearance/
// structured-data) and verified against the current (2025-2026) docs.
//
// Each entry keys off a schema.org @type and lists:
//   required:    properties Google needs for eligibility (missing -> error)
//   recommended: properties Google suggests (missing -> warning)
//   oneOf:       groups where at least one of the listed props must be present
//   note:        a policy/eligibility caveat surfaced as an advisory warning
//   docs:        link to the relevant Google documentation
//
// IMPORTANT accuracy notes baked into these rules (per current Google docs):
//  - Article / Organization have NO required properties — everything is
//    recommended. Hard-requiring headline/image/author/name would over-reject.
//  - JobPosting.jobLocation is NOT required for fully-remote (TELECOMMUTE) jobs;
//    expressed as "jobLocation OR applicantLocationRequirements".
//  - VideoObject needs at least one of contentUrl/embedUrl to be usable.
//  - Offer accepts priceSpecification as an alternative to price/priceCurrency.
//  - FAQ rich results are limited to gov/health sites (Sep 2023); HowTo rich
//    results were removed (Sep 2023); Sitelinks Searchbox was removed (Nov 2024)
//    — surfaced as notes, the markup itself is not an error.

export const RICH_RESULTS = {
  // No required properties per Google; recommended only. Same rules for the
  // NewsArticle / BlogPosting subtypes.
  Article: {
    feature: 'Article',
    required: [],
    recommended: ['author', 'datePublished', 'dateModified', 'headline', 'image'],
    docs: 'https://developers.google.com/search/docs/appearance/structured-data/article',
  },
  NewsArticle: { aliasOf: 'Article' },
  BlogPosting: { aliasOf: 'Article' },

  BreadcrumbList: {
    feature: 'Breadcrumb',
    required: ['itemListElement'],
    recommended: [],
    docs: 'https://developers.google.com/search/docs/appearance/structured-data/breadcrumb',
  },

  // Product snippet experience (the lenient baseline): name + one of
  // offers/review/aggregateRating. Merchant-listing requirements (image + an
  // Offer with price > 0) are a stricter superset and are surfaced as
  // recommended so non-commerce product pages aren't wrongly failed.
  Product: {
    feature: 'Product',
    required: ['name'],
    recommended: ['image', 'description', 'brand', 'review', 'aggregateRating', 'sku', 'gtin', 'mpn'],
    oneOf: [{ props: ['offers', 'review', 'aggregateRating'], message: 'at least one of offers, review, or aggregateRating' }],
    docs: 'https://developers.google.com/search/docs/appearance/structured-data/product-snippet',
  },
  // Offer: price + priceCurrency, OR a priceSpecification carrying them.
  Offer: {
    feature: 'Offer',
    required: [],
    oneOf: [
      { props: ['price', 'priceSpecification'], message: 'price (or a priceSpecification)' },
      { props: ['priceCurrency', 'priceSpecification'], message: 'priceCurrency (or a priceSpecification)' },
    ],
    recommended: ['availability', 'priceValidUntil', 'url', 'itemCondition', 'shippingDetails', 'hasMerchantReturnPolicy'],
    docs: 'https://developers.google.com/search/docs/appearance/structured-data/merchant-listing',
  },
  AggregateRating: {
    feature: 'AggregateRating',
    required: ['ratingValue'],
    recommended: ['bestRating', 'worstRating'],
    oneOf: [{ props: ['reviewCount', 'ratingCount'], message: 'at least one of reviewCount or ratingCount' }],
    docs: 'https://developers.google.com/search/docs/appearance/structured-data/review-snippet',
  },
  // itemReviewed is omitted when the Review is nested inside the reviewed item,
  // so it is intentionally not required here.
  Review: {
    feature: 'Review',
    required: ['reviewRating', 'author'],
    recommended: ['datePublished'],
    note: 'Self-serving reviews on an Organization/LocalBusiness page are not eligible for star review rich results.',
    docs: 'https://developers.google.com/search/docs/appearance/structured-data/review-snippet',
  },

  FAQPage: {
    feature: 'FAQ',
    required: ['mainEntity'],
    recommended: [],
    note: 'Since Sep 2023, FAQ rich results are only shown for well-known authoritative government and health sites. The markup remains valid for other sites but will not produce a rich result.',
    docs: 'https://developers.google.com/search/docs/appearance/structured-data/faqpage',
  },
  // Question is used by both FAQPage and QAPage. FAQ needs acceptedAnswer; Q&A
  // allows suggestedAnswer — so require "one of" rather than acceptedAnswer alone.
  Question: {
    feature: 'Question',
    required: ['name'],
    oneOf: [{ props: ['acceptedAnswer', 'suggestedAnswer'], message: 'an acceptedAnswer or suggestedAnswer' }],
    recommended: [],
    docs: 'https://developers.google.com/search/docs/appearance/structured-data/faqpage',
  },
  QAPage: {
    feature: 'Q&A',
    required: ['mainEntity'],
    recommended: [],
    docs: 'https://developers.google.com/search/docs/appearance/structured-data/qapage',
  },

  Recipe: {
    feature: 'Recipe',
    required: ['name', 'image'],
    recommended: [
      'author', 'datePublished', 'description', 'prepTime', 'cookTime', 'totalTime',
      'recipeYield', 'recipeIngredient', 'recipeInstructions', 'recipeCategory',
      'recipeCuisine', 'keywords', 'nutrition', 'aggregateRating', 'video',
    ],
    docs: 'https://developers.google.com/search/docs/appearance/structured-data/recipe',
  },

  // location may be a Place (physical) or VirtualLocation (online); either
  // satisfies the requirement, so a single required "location" is correct.
  Event: {
    feature: 'Event',
    required: ['name', 'startDate', 'location'],
    recommended: ['endDate', 'description', 'image', 'offers', 'performer', 'organizer', 'eventStatus', 'eventAttendanceMode'],
    docs: 'https://developers.google.com/search/docs/appearance/structured-data/event',
  },

  // No required properties per Google; recommended only.
  Organization: {
    feature: 'Organization',
    required: [],
    recommended: ['name', 'url', 'logo', 'contactPoint', 'sameAs', 'address', 'telephone', 'email'],
    docs: 'https://developers.google.com/search/docs/appearance/structured-data/organization',
  },

  LocalBusiness: {
    feature: 'Local Business',
    required: ['name', 'address'],
    recommended: ['telephone', 'openingHoursSpecification', 'geo', 'url', 'priceRange', 'image'],
    docs: 'https://developers.google.com/search/docs/appearance/structured-data/local-business',
  },

  VideoObject: {
    feature: 'Video',
    required: ['name', 'thumbnailUrl', 'uploadDate'],
    oneOf: [{ props: ['contentUrl', 'embedUrl'], message: 'a contentUrl or embedUrl' }],
    recommended: ['description', 'duration', 'expires'],
    docs: 'https://developers.google.com/search/docs/appearance/structured-data/video',
  },

  // jobLocation is not required for fully-remote jobs (jobLocationType
  // TELECOMMUTE), which instead use applicantLocationRequirements.
  JobPosting: {
    feature: 'Job Posting',
    required: ['title', 'description', 'datePosted', 'hiringOrganization'],
    oneOf: [{ props: ['jobLocation', 'applicantLocationRequirements'], message: 'jobLocation (or applicantLocationRequirements for remote jobs)' }],
    recommended: ['baseSalary', 'employmentType', 'validThrough', 'jobLocationType', 'identifier'],
    docs: 'https://developers.google.com/search/docs/appearance/structured-data/job-posting',
  },

  // Standalone HowTo rich results were removed by Google in Sep 2023. The
  // HowToStep vocabulary is still valid *inside* Recipe.recipeInstructions.
  HowTo: {
    feature: 'HowTo',
    required: [],
    recommended: [],
    note: 'Standalone HowTo rich results were removed by Google in Sep 2023. This markup no longer produces a rich result (HowToStep is still valid inside a Recipe).',
    docs: 'https://developers.google.com/search/blog/2023/08/howto-faq-changes',
  },
};

// Resolve aliases (NewsArticle -> Article rules, keeping its own feature label).
export function ruleFor(typeName) {
  const rule = RICH_RESULTS[typeName];
  if (!rule) return null;
  if (rule.aliasOf) return { ...RICH_RESULTS[rule.aliasOf] };
  return rule;
}
