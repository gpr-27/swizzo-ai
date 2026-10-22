# Live Swiggy MCP responses (captured 2026-10-22 from the real servers)

These are REAL raw CallToolResult objects. Where they disagree with the docs, THESE win.
Key facts: (1) search_restaurants_dineout -> structuredContent is `{}`; data ONLY in content[0].text lines `N. Name — cuisines | 4.3★ | ₹1000 for two | Area (ID: 123)`.
(2) render_restaurants_dineout(restaurantIds, searches) returns full card JSON (photos, rating, offers, distance).
(3) get_available_slots -> slot data is in result._meta.slots (and _meta.deals), NOT structuredContent; reservationTime is a STRING.
(4) scenes discover_events returns NO events anywhere right now (server-side) -> must fall back to search_events + get_event_details.
(5) list_event_shows tickets are {id, name, availableInventory, price:{price:{units:'199'},discountedPrice:{units}}}; show id is a STRING; show_time_unix number.

## get_addresses
args: `{"page": 1}`

```json
{
 "_meta": {
  "widgetFlags": {
   "chatgptPlatformOverrides": true
  }
 },
 "content": [
  {
   "type": "text",
   "text": "Found 7 saved addresses (page 1 of 1, showing 7):\n1. [User] Test User: [flat redacted], West Tambaram, West Tambaram, Tambaram, Chennai, Tamil Nadu, India (ID: db7kh1c1d96ofdam8g8g__AMVEDwTGeS8WPRJQbO-o12)\n2. [Collage] Test User: Iiit, IIIT Tiruchirappalli, IIIT Tiruchirappalli, Trichy Madurai Hwy, IIIT Tiruchirappalli Campus, Tiruchirappalli, Tamil Nadu 620012, India (ID: d7eh7ibq0afrvc8h3ajg__AKLWjASvPRgZEFNWbOijVc)\n3. [GPR] Test User: [flat redacted], New Tippasandra, Bengaluru, Karnataka, India (ID: d1k9ctrdq1ocsktt0090__AMXrgASg728rGDWKq4_ky_)\n4. [Clg2] Test User: IIIT collage FATHIMANAGAR, Sethurapatti, Sethurapatti, Tamil Nadu, India (ID: d7euj6ifmsmggb1ou9u0__AKKoLASvPAYYm8iJKVUmsj)\n5. [Nagamangalam] Test User: Nagamangalam, Manikandam, Manikandam, Tamil Nadu 620012, India (ID: d9pc8lk1d96o5oskdiqg__AKPX4ASv49IllgrrEgWGCB)\n6. [Work] Test User: main gate, IIIT Nuzvid Campus, Rajiv Gandhi University of Knowledge Technologies (RGUKT) Nuzvidu, IIIT Nuzvid Campus, Nuzividu, Andhra Pradesh 521202, India (ID: d2ku2stohbd2k8c3qerg__AQAxIATRP9sStGTGD8O5gn)\n7. [Home] Test User: [flat redacted], Ongole, Andhra Pradesh 523001, India (ID: cpdepit19tt3f622h3ng__AOys_QTFP0od9ekkq38oQa)\n\nThe saved addresses are ranked for display. Suggested/preselected address ID: db7kh1c1d96ofdam8g8g__AMVEDwTGeS8WPRJQbO-o12. Ask the user to confirm the suggestion or choose from address IDs: db7kh1c1d96ofdam8g8g__AMVEDwTGeS8WPRJQbO-o12, d7eh7ibq0afrvc8h3ajg__AKLWjASvPRgZEFNWbOijVc, d1k9ctrdq1ocsktt0090__AMXrgASg728rGDWKq4_ky_, d7euj6ifmsmggb1ou9u0__AKKoLASvPAYYm8iJKVUmsj, d9pc8lk1d96o5oskdiqg__AKPX4ASv49IllgrrEgWGCB, d2ku2stohbd2k8c3qerg__AQAxIATRP9sStGTGD8O5gn, cpdepit19tt3f622h3ng__AOys_QTFP0od9ekkq38oQa. Do not call downstream tools until they choose.\n\n⚠️ A rich UI widget may be shown to the user with this data. Avoid restating everything the widget already displays — instead, provide a brief recommendation or ask what they'd like to do next."
  }
 ],
 "structuredContent": {
  "addresses": [
   {
    "id": "db7kh1c1d96ofdam8g8g__AMVEDwTGeS8WPRJQbO-o12",
    "addressLine": "Test User: [flat redacted], West Tambaram, West Tambaram, Tambaram, Chennai, Tamil Nadu, India",
    "phoneNumber": "****6256",
    "addressCategory": "Other",
    "addressTag": "User"
   },
   {
    "id": "d7eh7ibq0afrvc8h3ajg__AKLWjASvPRgZEFNWbOijVc",
    "addressLine": "Test User: Iiit, IIIT Tiruchirappalli, IIIT Tiruchirappalli, Trichy Madurai Hwy, IIIT Tiruchirappalli Campus, Tiruchirappalli, Tamil Nadu 620012, India",
    "phoneNumber": "****6256",
    "addressCategory": "Other",
    "addressTag": "Collage"
   },
   {
    "id": "d1k9ctrdq1ocsktt0090__AMXrgASg728rGDWKq4_ky_",
    "addressLine": "Test User: [flat redacted], New Tippasandra, Bengaluru, Karnataka, India",
    "phoneNumber": "****6256",
    "addressCategory": "Other",
    "addressTag": "GPR"
   },
   {
    "id": "d7euj6ifmsmggb1ou9u0__AKKoLASvPAYYm8iJKVUmsj",
    "addressLine": "Test User: IIIT collage FATHIMANAGAR, Sethurapatti, Sethurapatti, Tamil Nadu, India",
    "phoneNumber": "****6256",
    "addressCategory": "Other",
    "addressTag": "Clg2"
   },
   {
    "id": "d9pc8lk1d96o5oskdiqg__AKPX4ASv49IllgrrEgWGCB",
    "addressLine": "Test User: Nagamangalam, Manikandam, Manikandam, Tamil Nadu 620012, India",
    "phoneNumber": "****6256",
    "addressCategory": "Other",
    "addressTag": "Nagamangalam"
   },
   {
    "id": "d2ku2stohbd2k8c3qerg__AQAxIATRP9sStGTGD8O5gn",
    "addressLine": "Test User: main gate, IIIT Nuzvid Campus, Rajiv Gandhi University of Knowledge Technologies (RGUKT) Nuzvidu, IIIT Nuzvid Campus, Nuzividu, Andhra Pradesh 521202, India",
    "phoneNumber": "****6256",
    "addressCategory": "Work",
    "addressTag": "Work"
   },
   {
    "id": "cpdepit19tt3f622h3ng__AOys_QTFP0od9ekkq38oQa",
    "addressLine": "Test User: [flat redacted], Ongole, Andhra Pradesh 523001, India",
    "phoneNumber": "****6256",
    "addressCategory": "Home",
    "addressTag": "Home"
   }
  ],
  "total": 7,
  "pagination": {
   "page": 1,
   "pageSize": 10,
   "total": 7,
   "totalPages": 1,
   "hasMore": false
  },
  "resolution": {
   "resolutionSource": "ranked_saved_address",
   "needsUserClarification": true,
   "candidateAddressIds": [
    "db7kh1c1d96ofdam8g8g__AMVEDwTGeS8WPRJQbO-o12",
    "d7eh7ibq0afrvc8h3ajg__AKLWjASvPRgZEFNWbOijVc",
    "d1k9ctrdq1ocsktt0090__AMXrgASg728rGDWKq4_ky_",
    "d7euj6ifmsmggb1ou9u0__AKKoLASvPAYYm8iJKVUmsj",
    "d9pc8lk1d96o5oskdiqg__AKPX4ASv49IllgrrEgWGCB",
    "d2ku2stohbd2k8c3qerg__AQAxIATRP9sStGTGD8O5gn",
    "cpdepit19tt3f622h3ng__AOys_QTFP0od9ekkq38oQa"
   ],
   "defaultAddressId": "db7kh1c1d96ofdam8g8g__AMVEDwTGeS8WPRJQbO-o12",
   "scoreUsed": 1
  },
  "imWidgetV2Eligible": true
 }
}
```

## get_payment_options
args: `{}`

```json
{
 "_meta": {
  "widgetFlags": {
   "chatgptPlatformOverrides": true
  }
 },
 "content": [
  {
   "type": "text",
   "text": "Found 8 UPI option(s) + Cash on Delivery + Swiggy Money for this cart (₹231).\n\n- 📱 **Google Pay** _(`gpay://upi/`)_\n- 📱 **PhonePe UPI** _(`phonepe://`)_\n- 📱 **Paytm UPI** _(`paytmmp://`)_\n- 📱 **BHIM** _(`bhim://upi/`)_\n- 📱 **CRED UPI** _(`credpay://upi/`)_\n- 📱 **super.money** _(`super://`)_\n- 📱 **FamApp UPI** _(`fpupi://`)_\n- 💻 **Pay with QR** (scan QR)\n- 💵 **Pay on delivery**\n- 👛 **Swiggy Money** _(`SwiggyPay`)_\n\n👉 A payment picker is shown to the user — it lists the methods for their device (UPI apps on mobile, scan-QR on desktop) with the other options under \"Show more\". When the user picks, call checkout with the matching args: for a mobile UPI app → paymentMethod=\"UPI\" + intentApp=<the picked app id, byte-for-byte>; for desktop QR → paymentMethod=\"UPI\" + generateUPIQR=true; for Cash on Delivery → paymentMethod=\"Cash\"; for Swiggy Money → paymentMethod=\"SwiggyPay\".\n\n⚠️ A rich UI widget may be shown to the user with this data. Avoid restating everything the widget already displays — instead, provide a brief recommendation or ask what they'd like to do next."
  },
  {
   "type": "text",
   "text": "{\n  \"platforms\": {\n    \"mobile\": {\n      \"groupName\": \"UPI\",\n      \"methods\": [\n        {\n          \"id\": \"gpay://upi/\",\n          \"displayName\": \"Google Pay\",\n          \"kind\": \"intent\",\n          \"iconUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/PaymentLogos/paymentIcons/upicollect/gpay\"\n        },\n        {\n          \"id\": \"phonepe://\",\n          \"displayName\": \"PhonePe UPI\",\n          \"kind\": \"intent\",\n          \"iconUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/PaymentLogos/paymentIcons/upicollect/phonepe\"\n        },\n        {\n          \"id\": \"paytmmp://\",\n          \"displayName\": \"Paytm UPI\",\n          \"kind\": \"intent\",\n          \"iconUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/portal/static-assets/icons/PaymentLogos/paymentIcons/PaytmLogo.png\"\n        },\n        {\n          \"id\": \"bhim://upi/\",\n          \"displayName\": \"BHIM\",\n          \"kind\": \"intent\",\n          \"iconUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/PaymentLogos/paymentIcons/upicollect/bhim\"\n        },\n        {\n          \"id\": \"credpay://upi/\",\n          \"displayName\": \"CRED UPI\",\n          \"kind\": \"intent\",\n          \"iconUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/payments/upi/CRED_logo.png\"\n        },\n        {\n          \"id\": \"super://\",\n          \"displayName\": \"super.money\",\n          \"kind\": \"intent\",\n          \"iconUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/portal/m/cw-pay-logos/sm-standard.png\"\n        },\n        {\n          \"id\": \"fpupi://\",\n          \"displayName\": \"FamApp UPI\",\n          \"kind\": \"intent\",\n          \"iconUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/portal/static-assets/images/famapp-logo.png\"\n        }\n      ]\n    },\n    \"desktop\": {\n      \"groupName\": \"UPI\",\n      \"methods\": [\n        {\n          \"id\": \"PayWithQR\",\n          \"displayName\": \"Pay with QR\",\n          \"kind\": \"qr\"\n        }\n      ]\n    }\n  },\n  \"cod\": {\n    \"available\": true,\n    \"id\": \"COD\",\n    \"displayName\": \"Pay on delivery\"\n  },\n  \"swiggyMoney\": {\n    \"available\": true,\n    \"id\": \"SwiggyPay\",\n    \"displayName\": \"Swiggy Money\"\n  },\n  \"allMethods\": [\n    {\n      \"id\": \"gpay://upi/\",\n      \"groupName\": \"UPI\",\n      \"displayName\": \"Google Pay\",\n      \"iconUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/PaymentLogos/paymentIcons/upicollect/gpay\",\n      \"enabled\": true,\n      \"raw\": {\n        \"groupName\": \"UPI\",\n        \"upiIntent\": true,\n        \"name\": \"gpay://upi/\",\n        \"display_name\": \"Google Pay\",\n        \"payment_code\": \"UPI\",\n        \"enabled\": true\n      }\n    },\n    {\n      \"id\": \"phonepe://\",\n      \"groupName\": \"UPI\",\n      \"displayName\": \"PhonePe UPI\",\n      \"iconUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/PaymentLogos/paymentIcons/upicollect/phonepe\",\n      \"enabled\": true,\n      \"raw\": {\n        \"groupName\": \"UPI\",\n        \"upiIntent\": true,\n        \"name\": \"phonepe://\",\n        \"display_name\": \"PhonePe UPI\",\n        \"payment_code\": \"UPI\",\n        \"enabled\": true\n      }\n    },\n    {\n      \"id\": \"paytmmp://\",\n      \"groupName\": \"UPI\",\n      \"displayName\": \"Paytm UPI\",\n      \"iconUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/portal/static-assets/icons/PaymentLogos/paymentIcons/PaytmLogo.png\",\n      \"enabled\": true,\n      \"raw\": {\n        \"groupName\": \"UPI\",\n        \"upiIntent\": true,\n        \"name\": \"paytmmp://\",\n        \"display_name\": \"Paytm UPI\",\n        \"payment_code\": \"UPI\",\n        \"enabled\": true\n      }\n    },\n    {\n      \"id\": \"bhim://upi/\",\n      \"groupName\": \"UPI\",\n      \"displayName\": \"BHIM\",\n      \"iconUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/PaymentLogos/paymentIcons/upicollect/bhim\",\n      \"enabled\": true,\n      \"raw\": {\n        \"groupName\": \"UPI\",\n        \"upiIntent\": true,\n        \"name\": \"bhim://upi/\",\n        \"display_name\": \"BHIM\",\n        \"payment_code\": \"UPI\",\n        \"enabled\": true\n      }\n    },\n    {\n      \"id\": \"credpay://upi/\",\n      \"groupName\": \"UPI\",\n      \"displayName\": \"CRED UPI\",\n      \"iconUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/payments/upi/CRED_logo.png\",\n      \"enabled\": true,\n      \"raw\": {\n        \"groupName\": \"UPI\",\n        \"upiIntent\": true,\n        \"name\": \"credpay://upi/\",\n        \"display_name\": \"CRED UPI\",\n        \"payment_code\": \"UPI\",\n        \"enabled\": true\n      }\n    },\n    {\n      \"id\": \"super://\",\n      \"groupName\": \"UPI\",\n      \"displayName\": \"super.money\",\n      \"iconUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/portal/m/cw-pay-logos/sm-standard.png\",\n      \"enabled\": true,\n      \"raw\": {\n        \"groupName\": \"UPI\",\n        \"upiIntent\": true,\n        \"name\": \"super://\",\n        \"display_name\": \"super.money\",\n        \"payment_code\": \"UPI\",\n        \"enabled\": true\n      }\n    },\n    {\n      \"id\": \"fpupi://\",\n      \"groupName\": \"UPI\",\n      \"displayName\": \"FamApp UPI\",\n      \"iconUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/portal/static-assets/images/famapp-logo.png\",\n      \"enabled\": true,\n      \"raw\": {\n        \"groupName\": \"UPI\",\n        \"upiIntent\": true,\n        \"name\": \"fpupi://\",\n        \"display_name\": \"FamApp UPI\",\n        \"payment_code\": \"UPI\",\n        \"enabled\": true\n      }\n    },\n    {\n      \"id\": \"PayWithQR\",\n      \"groupName\": \"UPI\",\n      \"displayName\": \"Pay with QR\",\n      \"enabled\": true,\n      \"raw\": {\n        \"groupName\": \"UPI\",\n        \"upiIntent\": false,\n        \"name\": \"PayWithQR\",\n        \"display_name\": \"Pay with QR\",\n        \"payment_code\": \"UPI\",\n        \"enabled\": true\n      }\n    },\n    {\n      \"id\": \"COD\",\n      \"groupName\": \"COD\",\n      \"displayName\": \"Pay on delivery\",\n      \"enabled\": true,\n      \"raw\": {\n        \"groupName\": \"COD\",\n        \"upiIntent\": false,\n        \"name\": \"COD\",\n        \"display_name\": \"Pay on delivery\",\n        \"payment_code\": \"Cash\",\n        \"enabled\": true\n      }\n    },\n    {\n      \"id\": \"SwiggyPay\",\n      \"groupName\": \"SWIGGYPAY\",\n      \"displayName\": \"Swiggy Money\",\n      \"enabled\": true,\n      \"raw\": {\n        \"groupName\": \"SWIGGYPAY\",\n        \"upiIntent\": false,\n        \"name\": \"SwiggyPay\",\n        \"display_name\": \"Swiggy Money\",\n        \"payment_code\": \"SwiggyPay\",\n        \"enabled\": true,\n        \"meta\": {}\n      }\n    }\n  ],\n  \"agenticPaymentEligible\": false,\n  \"paymentAmount\": \"231\",\n  \"placeOrderToolName\": \"checkout\",\n  \"imWidgetV2Eligible\": true\n}"
  }
 ],
 "structuredContent": {
  "platforms": {
   "mobile": {
    "groupName": "UPI",
    "methods": [
     {
      "id": "gpay://upi/",
      "displayName": "Google Pay",
      "kind": "intent",
      "iconUrl": "https://media-assets.swiggy.com/swiggy/image/upload/PaymentLogos/paymentIcons/upicollect/gpay"
     },
     {
      "id": "phonepe://",
      "displayName": "PhonePe UPI",
      "kind": "intent",
      "iconUrl": "https://media-assets.swiggy.com/swiggy/image/upload/PaymentLogos/paymentIcons/upicollect/phonepe"
     },
     {
      "id": "paytmmp://",
      "displayName": "Paytm UPI",
      "kind": "intent",
      "iconUrl": "https://media-assets.swiggy.com/swiggy/image/upload/portal/static-assets/icons/PaymentLogos/paymentIcons/PaytmLogo.png"
     },
     {
      "id": "bhim://upi/",
      "displayName": "BHIM",
      "kind": "intent",
      "iconUrl": "https://media-assets.swiggy.com/swiggy/image/upload/PaymentLogos/paymentIcons/upicollect/bhim"
     },
     {
      "id": "credpay://upi/",
      "displayName": "CRED UPI",
      "kind": "intent",
      "iconUrl": "https://media-assets.swiggy.com/swiggy/image/upload/payments/upi/CRED_logo.png"
     },
     {
      "id": "super://",
      "displayName": "super.money",
      "kind": "intent",
      "iconUrl": "https://media-assets.swiggy.com/swiggy/image/upload/portal/m/cw-pay-logos/sm-standard.png"
     },
     {
      "id": "fpupi://",
      "displayName": "FamApp UPI",
      "kind": "intent",
      "iconUrl": "https://media-assets.swiggy.com/swiggy/image/upload/portal/static-assets/images/famapp-logo.png"
     }
    ]
   },
   "desktop": {
    "groupName": "UPI",
    "methods": [
     {
      "id": "PayWithQR",
      "displayName": "Pay with QR",
      "kind": "qr"
     }
    ]
   }
  },
  "cod": {
   "available": true,
   "id": "COD",
   "displayName": "Pay on delivery"
  },
  "swiggyMoney": {
   "available": true,
   "id": "SwiggyPay",
   "displayName": "Swiggy Money"
  },
  "allMethods": [
   {
    "id": "gpay://upi/",
    "groupName": "UPI",
    "displayName": "Google Pay",
    "iconUrl": "https://media-assets.swiggy.com/swiggy/image/upload/PaymentLogos/paymentIcons/upicollect/gpay",
    "enabled": true,
    "raw": {
     "groupName": "UPI",
     "upiIntent": true,
     "name": "gpay://upi/",
     "display_name": "Google Pay",
     "payment_code": "UPI",
     "enabled": true
    }
   },
   {
    "id": "phonepe://",
    "groupName": "UPI",
    "displayName": "PhonePe UPI",
    "iconUrl": "https://media-assets.swiggy.com/swiggy/image/upload/PaymentLogos/paymentIcons/upicollect/phonepe",
    "enabled": true,
    "raw": {
     "groupName": "UPI",
     "upiIntent": true,
     "name": "phonepe://",
     "display_name": "PhonePe UPI",
     "payment_code": "UPI",
     "enabled": true
    }
   },
   {
    "id": "paytmmp://",
    "groupName": "UPI",
    "displayName": "Paytm UPI",
    "iconUrl": "https://media-assets.swiggy.com/swiggy/image/upload/portal/static-assets/icons/PaymentLogos/paymentIcons/PaytmLogo.png",
    "enabled": true,
    "raw": {
     "groupName": "UPI",
     "upiIntent": true,
     "name": "paytmmp://",
     "display_name": "Paytm UPI",
     "payment_code": "UPI",
     "enabled": true
    }
   },
   {
    "id": "bhim://upi/",
    "groupName": "UPI",
    "displayName": "BHIM",
    "iconUrl": "https://media-assets.swiggy.com/swiggy/image/upload/PaymentLogos/paymentIcons/upicollect/bhim",
    "enabled": true,
    "raw": {
     "groupName": "UPI",
     "upiIntent": true,
     "name": "bhim://upi/",
     "display_name": "BHIM",
     "payment_code": "UPI",
     "enabled": true
    }
   },
   {
    "id": "credpay://upi/",
    "groupName": "UPI",
    "displayName": "CRED UPI",
    "iconUrl": "https://media-assets.swiggy.com/swiggy/image/upload/payments/upi/CRED_logo.png",
    "enabled": true,
    "raw": {
     "groupName": "UPI",
     "upiIntent": true,
     "name": "credpay://upi/",
     "display_name": "CRED UPI",
     "payment_code": "UPI",
     "enabled": true
    }
   },
   {
    "id": "super://",
    "groupName": "UPI",
    "displayName": "super.money",
    "iconUrl": "https://media-assets.swiggy.com/swiggy/image/upload/portal/m/cw-pay-logos/sm-standard.png",
    "enabled": true,
    "raw": {
     "groupName": "UPI",
     "upiIntent": true,
     "name": "super://",
     "display_name": "super.money",
     "payment_code": "UPI",
     "enabled": true
    }
   },
   {
    "id": "fpupi://",
    "groupName": "UPI",
    "displayName": "FamApp UPI",
    "iconUrl": "https://media-assets.swiggy.com/swiggy/image/upload/portal/static-assets/images/famapp-logo.png",
    "enabled": true,
    "raw": {
     "groupName": "UPI",
     "upiIntent": true,
     "name": "fpupi://",
     "display_name": "FamApp UPI",
     "payment_code": "UPI",
     "enabled": true
    }
   },
   {
    "id": "PayWithQR",
    "groupName": "UPI",
    "displayName": "Pay with QR",
    "enabled": true,
    "raw": {
     "groupName": "UPI",
     "upiIntent": false,
     "name": "PayWithQR",
     "display_name": "Pay with QR",
     "payment_code": "UPI",
     "enabled": true
    }
   },
   {
    "id": "COD",
    "groupName": "COD",
    "displayName": "Pay on delivery",
    "enabled": true,
    "raw": {
     "groupName": "COD",
     "upiIntent": false,
     "name": "COD",
     "display_name": "Pay on delivery",
     "payment_code": "Cash",
     "enabled": true
    }
   },
   {
    "id": "SwiggyPay",
    "groupName": "SWIGGYPAY",
    "displayName": "Swiggy Money",
    "enabled": true,
    "raw": {
     "groupName": "SWIGGYPAY",
     "upiInten
... [truncated]
```

## get_orders
args: `{"count": 20}`

```json
{
 "content": [
  {
   "type": "text",
   "text": "Found 0 orders from the last 15 days. Each order includes full tracking details."
  },
  {
   "type": "text",
   "text": "{\n  \"orders\": [],\n  \"hasMore\": false\n}"
  }
 ],
 "structuredContent": {
  "orders": [],
  "hasMore": false
 }
}
```

## your_go_to_items
args: `{"addressId": "db7kh1c1d96ofdam8g8g__AMVEDwTGeS8WPRJQbO-o12", "offset": 0}`

```json
{
 "_meta": {
  "widgetFlags": {
   "chatgptPlatformOverrides": true
  }
 },
 "content": [
  {
   "type": "text",
   "text": "Found 12 Your Go To Items.\n\nDISPLAY INSTRUCTIONS:\n- Show each product with: Brand + Display Name\n- List variations under each product with: quantity, price (MRP vs offer price if discounted)\n- Products with isPromoted=true are sponsored; display with ⭐ and mention \"Featured/Sponsored\"\n- When the user wants to add an item, pass BOTH spinId and skuId from the chosen variation to update_cart.\n\n⚠️ A rich UI widget may be shown to the user with this data. Avoid restating everything the widget already displays — instead, provide a brief recommendation or ask what they'd like to do next."
  },
  {
   "type": "text",
   "text": "{\n  \"nextOffset\": \"0\",\n  \"products\": [\n    {\n      \"displayName\": \"English Cucumber (Vellarikkai)\",\n      \"brand\": \"Fruits & Vegetables Category\",\n      \"inStock\": true,\n      \"isAvail\": true,\n      \"variations\": [\n        {\n          \"spinId\": \"M81OWJ2782\",\n          \"skuId\": \"015NWQS292\",\n          \"quantityDescription\": \"500 g x 2\",\n          \"displayName\": \"English Cucumber (Vellarikkai)\",\n          \"brandName\": \"Fruits & Vegetables Category\",\n          \"price\": {\n            \"mrp\": 120,\n            \"offerPrice\": 88,\n            \"unitLevelPrice\": \"8.8/100 g\"\n          },\n          \"isInStockAndAvailable\": true,\n          \"imageUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/NI_CATALOG/IMAGES/CIW/2026/3/24/66613c9a-78a5-4ad8-b91f-38240a72e383_7821_1.jpg\",\n          \"sla\": {\n            \"value\": \"11\",\n            \"unit\": \"MINS\"\n          },\n          \"vegClassifier\": \"VEG_CLASSIFIER_VEG\",\n          \"maxQuantity\": 1,\n          \"maxQuantityMessage\": \"That’s all we have in stock at the moment!\"\n        },\n        {\n          \"spinId\": \"V7INJOLGVI\",\n          \"skuId\": \"GIQL6IRBH5\",\n          \"quantityDescription\": \"500 g\",\n          \"displayName\": \"English Cucumber (Vellarikkai)\",\n          \"brandName\": \"Fruits & Vegetables Category\",\n          \"price\": {\n            \"mrp\": 60,\n            \"offerPrice\": 45,\n            \"unitLevelPrice\": \"9/100 g\"\n          },\n          \"isInStockAndAvailable\": true,\n          \"imageUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/NI_CATALOG/IMAGES/CIW/2026/3/24/66613c9a-78a5-4ad8-b91f-38240a72e383_7821_1.jpg\",\n          \"sla\": {\n            \"value\": \"11\",\n            \"unit\": \"MINS\"\n          },\n          \"vegClassifier\": \"VEG_CLASSIFIER_VEG\",\n          \"maxQuantity\": 3,\n          \"maxQuantityMessage\": \"That’s all we have in stock at the moment!\"\n        }\n      ],\n      \"productId\": \"T8NZBV082Q\",\n      \"parentProductId\": \"FQ3V46QCZJ\",\n      \"isPromoted\": false\n    },\n    {\n      \"displayName\": \"Milky Mist Skyr\",\n      \"brand\": \"Milky Mist\",\n      \"inStock\": true,\n      \"isAvail\": true,\n      \"variations\": [\n        {\n          \"spinId\": \"W5XN23EPIF\",\n          \"skuId\": \"XV0MURJ6T3\",\n          \"quantityDescription\": \"700 g x 2\",\n          \"displayName\": \"Milky Mist Skyr\",\n          \"brandName\": \"Milky Mist\",\n          \"price\": {\n            \"mrp\": 760,\n            \"offerPrice\": 660,\n            \"unitLevelPrice\": \"47.1/100 g\"\n          },\n          \"isInStockAndAvailable\": true,\n          \"imageUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/NI_CATALOG/IMAGES/ciw/2026/6/20/bc31567c-c755-482e-bf33-fca9a78060d5_12_215e23b4-2e22-4939-a8e6-77ad132859f8.png\",\n          \"rating\": {\n            \"value\": \"4.4\",\n            \"count\": \"2k\"\n          },\n          \"sla\": {\n            \"value\": \"11\",\n            \"unit\": \"MINS\"\n          },\n          \"vegClassifier\": \"VEG_CLASSIFIER_VEG\",\n          \"maxQuantity\": 3,\n          \"maxQuantityMessage\": \"That’s all we have in stock at the moment!\"\n        },\n        {\n          \"spinId\": \"7Z2YUUZ7U4\",\n          \"skuId\": \"TA8QKFHYY2\",\n          \"quantityDescription\": \"700 g\",\n          \"displayName\": \"Milky Mist Skyr\",\n          \"brandName\": \"Milky Mist\",\n          \"price\": {\n            \"mrp\": 380,\n            \"offerPrice\": 330,\n            \"unitLevelPrice\": \"47.1/100 g\"\n          },\n          \"isInStockAndAvailable\": true,\n          \"imageUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/NI_CATALOG/IMAGES/ciw/2026/6/20/bc31567c-c755-482e-bf33-fca9a78060d5_12_215e23b4-2e22-4939-a8e6-77ad132859f8.png\",\n          \"rating\": {\n            \"value\": \"4.4\",\n            \"count\": \"2k\"\n          },\n          \"sla\": {\n            \"value\": \"11\",\n            \"unit\": \"MINS\"\n          },\n          \"vegClassifier\": \"VEG_CLASSIFIER_VEG\",\n          \"maxQuantity\": 6,\n          \"maxQuantityMessage\": \"Only 6 unit(s) of this item can be added per order.\"\n        }\n      ],\n      \"productId\": \"VVB5LMWDYP\",\n      \"parentProductId\": \"VUJRRXGZKK\",\n      \"isPromoted\": false\n    },\n    {\n      \"displayName\": \"Heritage High Protein Paneer\",\n      \"brand\": \"Heritage\",\n      \"inStock\": true,\n      \"isAvail\": true,\n      \"variations\": [\n        {\n          \"spinId\": \"TAN24Z461J\",\n          \"skuId\": \"X97HOSYVWK\",\n          \"quantityDescription\": \"240 g\",\n          \"displayName\": \"Heritage High Protein Paneer\",\n          \"brandName\": \"Heritage\",\n          \"price\": {\n            \"mrp\": 160,\n            \"offerPrice\": 122,\n            \"unitLevelPrice\": \"50.8/100 g\"\n          },\n          \"isInStockAndAvailable\": true,\n          \"imageUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/NI_CATALOG/IMAGES/CIW/2026/1/5/00fd26bf-2a99-4dda-9b79-6e43e6392e81_451477_1.png\",\n          \"rating\": {\n            \"value\": \"4.0\",\n            \"count\": \"13.6k\"\n          },\n          \"sla\": {\n            \"value\": \"11\",\n            \"unit\": \"MINS\"\n          },\n          \"vegClassifier\": \"VEG_CLASSIFIER_VEG\",\n          \"maxQuantity\": 6,\n          \"maxQuantityMessage\": \"Only 6 unit(s) of this item can be added per order.\"\n        }\n      ],\n      \"productId\": \"2PDWXPVQX0\",\n      \"parentProductId\": \"ED8JVCJHPB\",\n      \"isPromoted\": false\n    },\n    {\n      \"displayName\": \"Cucumber (Vellaraikkai)\",\n      \"brand\": \"Fruits & Vegetables Category\",\n      \"inStock\": true,\n      \"isAvail\": true,\n      \"variations\": [\n        {\n          \"spinId\": \"MFPXQBV7WU\",\n          \"skuId\": \"U2647I2RQ0\",\n          \"quantityDescription\": \"2 Pieces x 2\",\n          \"displayName\": \"Cucumber (Vellaraikkai)\",\n          \"brandName\": \"Fruits & Vegetables Category\",\n          \"price\": {\n            \"mrp\": 76,\n            \"offerPrice\": 54,\n            \"unitLevelPrice\": \"13.5/piece\"\n          },\n          \"isInStockAndAvailable\": true,\n          \"imageUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/NI_CATALOG/IMAGES/CIW/2026/6/22/b2a2c632-bfcc-42d7-a97b-f289d2f80d93_19027_1.jpg\",\n          \"sla\": {\n            \"value\": \"11\",\n            \"unit\": \"MINS\"\n          },\n          \"vegClassifier\": \"VEG_CLASSIFIER_VEG\",\n          \"maxQuantity\": 2,\n          \"maxQuantityMessage\": \"Only 2 unit(s) of this item can be added per order.\"\n        },\n        {\n          \"spinId\": \"SWKMAPUSAM\",\n          \"skuId\": \"C8I4P19QDC\",\n          \"quantityDescription\": \"2 Pieces\",\n          \"displayName\": \"Cucumber (Vellaraikkai)\",\n          \"brandName\": \"Fruits & Vegetables Category\",\n          \"price\": {\n            \"mrp\": 38,\n            \"offerPrice\": 28,\n            \"unitLevelPrice\": \"14/piece\"\n          },\n          \"isInStockAndAvailable\": true,\n          \"imageUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/NI_CATALOG/IMAGES/CIW/2026/6/22/b2a2c632-bfcc-42d7-a97b-f289d2f80d93_19027_1.jpg\",\n          \"sla\": {\n            \"value\": \"11\",\n            \"unit\": \"MINS\"\n          },\n          \"vegClassifier\": \"VEG_CLASSIFIER_VEG\",\n          \"maxQuantity\": 5,\n          \"maxQuantityMessage\": \"Only 5 unit(s) of this item can be added per order.\"\n        }\n      ],\n      \"productId\": \"AIZ20L10E6\",\n      \"parentProductId\": \"HLQ4RDK2XM\",\n      \"isPromoted\": false\n    },\n    {\n      \"displayName\": \"Ginger (Inji)\",\n      \"brand\": \"Fruits & Vegetables Category\",\n      \"inStock\": true,\n      \"isAvail\": true,\n      \"variations\": [\n        {\n          \"spinId\": \"DZNDGQC4GL\",\n          \"skuId\": \"IACTNZU54W\",\n          \"quantityDescription\": \"200 g x 2\",\n          \"displayName\": \"Ginger (Inji)\",\n          \"brandName\": \"Fruits & Vegetables Category\",\n          \"price\": {\n            \"mrp\": 146,\n            \"offerPrice\": 102,\n            \"unitLevelPrice\": \"25.5/100 g\"\n          },\n          \"isInStockAndAvailable\": true,\n          \"imageUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/NI_CATALOG/IMAGES/CIW/2026/9/3/ffdcb8d6-f764-461d-bb4a-ceb7be53280f_3795_1.png\",\n          \"sla\": {\n            \"value\": \"11\",\n            \"unit\": \"MINS\"\n          },\n          \"vegClassifier\": \"VEG_CLASSIFIER_VEG\",\n          \"maxQuantity\": 2,\n          \"maxQuantityMessage\": \"Only 2 unit(s) of this item can be added per order.\"\n        },\n        {\n          \"spinId\": \"410ACHP4RV\",\n          \"skuId\": \"MJ4MI6LRRV\",\n          \"quantityDescription\": \"200 g\",\n          \"displayName\": \"Ginger (Inji)\",\n          \"brandName\": \"Fruits & Vegetables Category\",\n          \"price\": {\n            \"mrp\": 73,\n            \"offerPrice\": 52,\n            \"unitLevelPrice\": \"26/100 g\"\n          },\n          \"isInStockAndAvailable\": true,\n          \"imageUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/NI_CATALOG/IMAGES/CIW/2026/9/2/be4fa084-8471-4c07-ade1-7685cfd5ad59_3795.png\",\n          \"sla\": {\n            \"value\": \"11\",\n            \"unit\": \"MINS\"\n          },\n          \"vegClassifier\": \"VEG_CLASSIFIER_VEG\",\n          \"maxQuantity\": 5,\n          \"maxQuantityMessage\": \"Only 5 unit(s) of this item can be added per order.\"\n        }\n      ],\n      \"productId\": \"0FYKU31E4B\",\n      \"parentProductId\": \"TA28GGRU1L\",\n      \"isPromoted\": false\n    },\n    {\n      \"displayName\": \"iD Fresh High Protein Paneer (56g Protein)\",\n      \"brand\": \"iD Fresh\",\n      \"inStock\": true,\n      \"isAvail\": true,\n      \"variations\": [\n        {\n          \"spinId\": \"6HKWY63IA4\",\n          \"skuId\": \"TPLW32R1LY\",\n          \"quantityDescription\": \"200 g\",\n          \"displayName\": \"iD Fresh High Protein Paneer (56g Protein)\",\n          \"brandName\": \"iD Fresh\",\n          \"price\": {\n            \"mrp\": 150,\n            \"offerPrice\": 138,\n            \"unitLevelPrice\": \"69/100 g\"\n          },\n          \"isInStockAndAvailable\": true,\n          \"imageUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/NI_CATALOG/IMAGES/CIW/2026/4/17/633772f2-d76c-43d6-ae64-75dadd6b5271_918282_1.png\",\n          \"rating\": {\n            \"value\": \"4.2\",\n            \"count\": \"6k\"\n          },\n          \"sla\": {\n            \"value\": \"11\",\n            \"unit\": \"MINS\"\n          },\n          \"vegClassifier\": \"VEG_CLASSIFIER_INVALID\",\n          \"maxQuantity\": 6,\n          \"maxQuantityMessage\": \"Only 6 unit(s) of this item can be added per order.\"\n        }\n      ],\n      \"productId\": \"MCIU52GXWH\",\n      \"parentProductId\": \"9POYKAY7VW\",\n      \"isPromoted\": false\n    },\n    {\n      \"displayName\": \"Go Cheese Pizza Cheese Mozzarella Cheddar Diced\",\n      \"brand\": \"Go Cheese\",\n      \"inStock\": true,\n      \"isAvail\": true,\n      \"variations\": [\n        {\n          \"spinId\": \"88X5S09ILB\",\n          \"skuId\": \"ASR2DIJ914\",\n          \"quantityDescription\": \"200 g\",\n          \"displayName\": \"Go Cheese Pizza Cheese Mozzarella Cheddar Diced\",\n          \"brandName\": \"Go Cheese\",\n          \"price\": {\n            \"mrp\": 159,\n            \"offerPrice\": 116,\n            \"unitLevelPrice\": \"58/100 g\"\n          },\n          \"isInStockAndAvailable\": true,\n          \"imageUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/NI_CATALOG/IMAGES/ciw/2025/12/17/e2670da6-d268-4c98-bcfd-ab731a3e25bf_88X5S09ILB_MN_17122025.png\",\n          \"rating\": {\n            \"value\": \"4.4\",\n            \"count\": \"4.3k\"\n          },\n          \"sla\": {\n            \"value\": \"11\",\n            \"unit\": \"MINS\"\n          },\n          \"vegClassifier\": \"VEG_CLASSIFIER_INVALID\",\n          \"maxQuantity\": 2,\n          \"maxQuantityMessage\": \"That’s all we have in stock at the moment!\"\n        }\n      ],\n      \"productId\": \"KMZDL07JMG\",\n      \"parentProductId\": \"DNZNRECLLM\",\n      \"isPromoted\": false\n    },\n    {\n      \"displayName\": \"Milky Mist High Protein Low Fat Paneer\",\n      \"brand\": \"Milky Mist\",\n      \"inStock\": true,\n      \"isAvail\": true,\n      \"variations\": [\n        {\n          \"spinId\": \"J4H6T336HN\",\n          \"skuId\": \"0HW2WC4RNM\",\n          \"quantityDescription\": \"200 g x 2\",\n          \"displayName\": \"Milky Mist High Protein Low Fat Paneer\",\n          \"brandName\": \"Milky Mist\",\n          \"price\": {\n            \"mrp\": 330,\n            \"offerPrice\": 202,\n            \"unitLevelPrice\": \"50.5/100 g\"\n          },\n          \"isInStockAndAvailable\": true,\n          \"imageUrl\": \"https://media-assets.
... [truncated]
```

## get_cart
args: `{}`

```json
{
 "_meta": {
  "widgetFlags": {
   "chatgptPlatformOverrides": true
  }
 },
 "content": [
  {
   "type": "text",
   "text": "Cart retrieved successfully. Please display the cart details in a tabular format showing:\n1. Delivery address (from selectedAddressDetails)\n2. Items table with columns: Item Name, Quantity, Unit Price, Total Price (include availability status)\n3. Cost breakdown table showing all charges from billBreakdown (item total, delivery charges, handling fees, GST, discounts, savings, and final total)\n4. Payment: when the user is ready to pay, call get_payment_options to show the payment methods (it returns the picker). Do NOT list payment methods here.\n5. Swiggy One Status: Active (ONE - PLUS)\n\n⚠️ A rich UI widget may be shown to the user with this data. Avoid restating everything the widget already displays — instead, provide a brief recommendation or ask what they'd like to do next."
  },
  {
   "type": "text",
   "text": "{\n  \"selectedAddress\": \"db7kh1c1d96ofdam8g8g\",\n  \"selectedAddressDetails\": {\n    \"id\": \"db7kh1c1d96ofdam8g8g\",\n    \"address\": \"West Tambaram, Tambaram, Chennai, Tamil Nadu, India\",\n    \"area\": \"West Tambaram\",\n    \"name\": \"Test User\",\n    \"mobile\": \"9000006256\",\n    \"lat\": 12.93,\n    \"lng\": 80.12,\n    \"annotation\": \"User\",\n    \"category\": \"OTHER\",\n    \"flatNo\": \"[flat redacted]\",\n    \"city\": \"Chennai\"\n  },\n  \"cartTotalAmount\": \"₹266\",\n  \"items\": [\n    {\n      \"spinId\": \"VRBN3GVWZ2\",\n      \"skuId\": \"2CG4J4927S\",\n      \"productId\": \"SF4DO4VQNE\",\n      \"itemName\": \"Godrej Yummiez Cheese Corn Nuggets\",\n      \"itemVariant\": \"400 g\",\n      \"quantity\": 1,\n      \"storeId\": 1404943,\n      \"isInStockAndAvailable\": true,\n      \"mrp\": 240,\n      \"discountedFinalPrice\": 219,\n      \"imageUrl\": \"https://media-assets.swiggy.com/swiggy/image/upload/NI_CATALOG/IMAGES/CIW/2026/3/12/e6d80569-66b6-4506-b762-693d7fa34ddc_3651_1.png\",\n      \"maxQuantity\": 3,\n      \"maxQuantityMessage\": \"That's all we have in stock at the moment!\"\n    }\n  ],\n  \"billBreakdown\": {\n    \"lineItems\": [\n      {\n        \"label\": \"Item Total\",\n        \"value\": \"₹219.00\"\n      },\n      {\n        \"label\": \"Handling Fee\",\n        \"value\": \"₹12.00\"\n      },\n      {\n        \"label\": \"Delivery Partner Fee\",\n        \"value\": \"FREE\"\n      },\n      {\n        \"label\": \"Late Night Fee\",\n        \"value\": \"₹35.40\"\n      }\n    ],\n    \"toPay\": {\n      \"label\": \"To Pay\",\n      \"value\": \"₹266\"\n    }\n  },\n  \"superData\": {\n    \"userStatus\": \"SUPER\",\n    \"program\": \"ONE\",\n    \"offering\": \"PLUS\"\n  },\n  \"cartId\": \"ace5f3ea-494f-44a2-b1c8-89f5a50236c6\"\n}"
  }
 ],
 "structuredContent": {
  "selectedAddress": "db7kh1c1d96ofdam8g8g",
  "selectedAddressDetails": {
   "id": "db7kh1c1d96ofdam8g8g",
   "address": "West Tambaram, Tambaram, Chennai, Tamil Nadu, India",
   "area": "West Tambaram",
   "name": "Test User",
   "mobile": "9000006256",
   "lat": 12.93,
   "lng": 80.12,
   "annotation": "User",
   "category": "OTHER",
   "flatNo": "[flat redacted]",
   "city": "Chennai"
  },
  "cartTotalAmount": "₹266",
  "items": [
   {
    "spinId": "VRBN3GVWZ2",
    "skuId": "2CG4J4927S",
    "productId": "SF4DO4VQNE",
    "itemName": "Godrej Yummiez Cheese Corn Nuggets",
    "itemVariant": "400 g",
    "quantity": 1,
    "storeId": 1404943,
    "isInStockAndAvailable": true,
    "mrp": 240,
    "discountedFinalPrice": 219,
    "imageUrl": "https://media-assets.swiggy.com/swiggy/image/upload/NI_CATALOG/IMAGES/CIW/2026/3/12/e6d80569-66b6-4506-b762-693d7fa34ddc_3651_1.png",
    "maxQuantity": 3,
    "maxQuantityMessage": "That's all we have in stock at the moment!"
   }
  ],
  "billBreakdown": {
   "lineItems": [
    {
     "label": "Item Total",
     "value": "₹219.00"
    },
    {
     "label": "Handling Fee",
     "value": "₹12.00"
    },
    {
     "label": "Delivery Partner Fee",
     "value": "FREE"
    },
    {
     "label": "Late Night Fee",
     "value": "₹35.40"
    }
   ],
   "toPay": {
    "label": "To Pay",
    "value": "₹266"
   }
  },
  "superData": {
   "userStatus": "SUPER",
   "program": "ONE",
   "offering": "PLUS"
  },
  "cartId": "ace5f3ea-494f-44a2-b1c8-89f5a50236c6"
 }
}
```

## get_food_orders
args: `{"addressId": "db7kh1c1d96ofdam8g8g__AMVEDwTGeS8WPRJQbO-o12", "orderCount": 15}`

```json
{
 "content": [
  {
   "type": "text",
   "text": "Found 5 orders:\n1. Order 250940466155091 — Bikkgane Biryani | October 14, 3:11 PM | Delivered | ₹341 [reorderable] — Special Chicken Hyderabadi Boneless Biryani (1)\n2. Order 244800472180064 — Isha Fast Food | August 4, 1:37 PM | Delivered | ₹36 [reorderable] — Chicken noodles (1),Chicken fried rice (1),Chilli chicken (1)\n3. Order 237822198473105 — Bismillah Hyderabad Dum Biryani | May 15, 7:13 PM | cancelled | ₹307 [reorderable] — Chicken Dum Biryani (1)\n4. Order 236248637984268 — Punjabi Dhaba | April 27, 2:07 PM | Delivered | ₹109 [reorderable] — Chicken rice (1)\n5. Order 235207521117114 — Punjabi Dhaba | April 15, 12:55 PM | Delivered | ₹110 [reorderable] — Chicken rice (1)\n\nFor items, image, delivery address and total paid of any order, call get_food_order_details with its orderId."
  }
 ],
 "structuredContent": {
  "orders": [
   {
    "orderId": "250940466155091",
    "restaurantId": "1058795",
    "restaurantName": "Bikkgane Biryani",
    "restaurantAreaName": "Tambaram, Kancheepuram",
    "orderTotal": "₹341",
    "orderStatus": "Delivered",
    "orderDeliveryStatus": "delivered",
    "orderType": "regular",
    "orderedItems": "Special Chicken Hyderabadi Boneless Biryani (1)",
    "orderedTime": "October 14, 3:11 PM",
    "isActiveOrder": false,
    "actions": [
     {
      "type": "PAST_ORDER_CTA_ENUM_REORDER",
      "priority": 1,
      "title": "REORDER",
      "isEnabled": true,
      "reorderMeta": {
       "orderItems": [
        {
         "itemId": "167173390",
         "name": "Special Chicken Hyderabadi Boneless Biryani",
         "isVeg": "0",
         "variants": [
          {
           "variationId": 178376719,
           "groupId": 57485311,
           "name": "Serves 2 - 1000ml",
           "price": 419,
           "externalChoiceId": "1281003915",
           "externalGroupId": "VG1281003905",
           "variantTaxCharges": {
            "gst": "0.0"
           },
           "variantTaxExpressions": {
            "gstInclusive": "false"
           },
           "gstDetails": {},
           "attributes": {}
          }
         ],
         "quantity": "1",
         "total": "438",
         "subtotal": "419",
         "packingCharges": "19",
         "categoryDetails": {
          "category": "Hyderabadi Biryani",
          "subCategory": "Non Veg Hyderabadi Biryani"
         },
         "attributes": {
          "portionSize": "0",
          "vegClassifier": "VEG_CLASSIFIER_NONVEG"
         }
        }
       ],
       "restaurantCoverImageId": "RX_THUMBNAIL/IMAGES/VENDOR/2025/12/4/0f39400c-adb7-4037-b5b5-a54b460e5a7f_1058795.JPG"
      }
     },
     {
      "type": "PAST_ORDER_CTA_ENUM_RATE_DELIVERY",
      "priority": 4,
      "title": "RATE DELIVERY",
      "isEnabled": true,
      "rateDeliveryMeta": {
       "ratingType": "delivery",
       "ratingTitle": "Not available"
      }
     }
    ]
   },
   {
    "orderId": "244800472180064",
    "restaurantId": "1195783",
    "restaurantName": "Isha Fast Food",
    "restaurantAreaName": "Viralimalai",
    "orderTotal": "₹36",
    "orderStatus": "Delivered",
    "orderDeliveryStatus": "delivered",
    "orderType": "regular",
    "orderedItems": "Chicken noodles (1),Chicken fried rice (1),Chilli chicken (1)",
    "orderedTime": "August 4, 1:37 PM",
    "isActiveOrder": false,
    "actions": [
     {
      "type": "PAST_ORDER_CTA_ENUM_REORDER",
      "priority": 1,
      "title": "REORDER",
      "isEnabled": true,
      "reorderMeta": {
       "orderItems": [
        {
         "itemId": "181437850",
         "name": "Chicken noodles",
         "isVeg": "0",
         "quantity": "1",
         "total": "110",
         "subtotal": "110",
         "packingCharges": "0",
         "categoryDetails": {
          "category": "Fried Noodles",
          "subCategory": "nota"
         },
         "attributes": {
          "portionSize": "0",
          "vegClassifier": "VEG_CLASSIFIER_NONVEG"
         }
        },
        {
         "itemId": "181437843",
         "name": "Chicken fried rice",
         "isVeg": "0",
         "quantity": "1",
         "total": "115",
         "subtotal": "115",
         "packingCharges": "0",
         "categoryDetails": {
          "category": "Fried Rice",
          "subCategory": "nota"
         },
         "attributes": {
          "portionSize": "0",
          "vegClassifier": "VEG_CLASSIFIER_NONVEG"
         }
        },
        {
         "itemId": "181437840",
         "name": "Chilli chicken",
         "isVeg": "0",
         "quantity": "1",
         "total": "145",
         "subtotal": "145",
         "packingCharges": "0",
         "categoryDetails": {
          "category": "Chinese Appetizers",
          "subCategory": "nota"
         },
         "attributes": {
          "portionSize": "0",
          "vegClassifier": "VEG_CLASSIFIER_NONVEG"
         }
        }
       ],
       "restaurantCoverImageId": "RX_THUMBNAIL/IMAGES/VENDOR/2025/9/5/9e8b0cbc-7f5d-4113-b88b-d9e2abf23018_1195783.jpg"
      }
     }
    ]
   },
   {
    "orderId": "237822198473105",
    "restaurantId": "183187",
    "restaurantName": "Bismillah Hyderabad Dum Biryani",
    "restaurantAreaName": "Mangamuru Road",
    "orderTotal": "₹307",
    "orderStatus": "cancelled",
    "orderType": "regular",
    "orderedItems": "Chicken Dum Biryani (1)",
    "orderedTime": "May 15, 7:13 PM",
    "isActiveOrder": false,
    "actions": [
     {
      "type": "PAST_ORDER_CTA_ENUM_REORDER",
      "priority": 1,
      "title": "REORDER",
      "isEnabled": true,
      "reorderMeta": {
       "orderItems": [
        {
         "itemId": "41588061",
         "name": "Chicken Dum Biryani",
         "isVeg": "0",
         "quantity": "1",
         "total": "289",
         "subtotal": "289",
         "packingCharges": "0",
         "categoryDetails": {
          "category": "Chicken Biryanis",
          "subCategory": "nota"
         },
         "attributes": {
          "portionSize": "1",
          "vegClassifier": "VEG_CLASSIFIER_NONVEG"
         }
        }
       ],
       "restaurantCoverImageId": "u7dynyeabdgn5rujasvl"
      }
     },
     {
      "type": "PAST_ORDER_CTA_ENUM_RATE_ORDER",
      "priority": 2,
      "title": "RATE ORDER",
      "isEnabled": true,
      "rateDeliveryMeta": {
       "ratingType": "delivery",
       "rateAll": true,
       "ratingTitle": "Not available"
      }
     }
    ]
   },
   {
    "orderId": "236248637984268",
    "restaurantId": "1203761",
    "restaurantName": "Punjabi Dhaba",
    "restaurantAreaName": "Viralimalai",
    "orderTotal": "₹109",
    "orderStatus": "Delivered",
    "orderDeliveryStatus": "delivered",
    "orderType": "regular",
    "orderedItems": "Chicken rice (1)",
    "orderedTime": "April 27, 2:07 PM",
    "isActiveOrder": false,
    "actions": [
     {
      "type": "PAST_ORDER_CTA_ENUM_REORDER",
      "priority": 1,
      "title": "REORDER",
      "isEnabled": true,
      "reorderMeta": {
       "orderItems": [
        {
         "itemId": "182051004",
         "name": "Chicken rice",
         "isVeg": "0",
         "quantity": "1",
         "total": "174",
         "subtotal": "174",
         "packingCharges": "0",
         "categoryDetails": {
          "category": "Fried Rice Varieties",
          "subCategory": "nota"
         },
         "attributes": {
          "portionSize": "0",
          "vegClassifier": "VEG_CLASSIFIER_NONVEG"
         }
        }
       ],
       "restaurantCoverImageId": "RX_THUMBNAIL/IMAGES/VENDOR/2026/1/20/95003306-b683-4e9c-a61a-bccee27ee0a8_1203761.jpg"
      }
     },
     {
      "type": "PAST_ORDER_CTA_ENUM_RATE_ORDER",
      "priority": 2,
      "title": "RATE ORDER",
      "isEnabled": true,
      "rateDeliveryMeta": {
       "ratingType": "delivery",
       "rateAll": true,
       "ratingTitle": "Not available"
      }
     }
    ]
   },
   {
    "orderId": "235207521117114",
    "restaurantId": "1203761",
    "restaurantName": "Punjabi Dhaba",
    "restaurantAreaName": "Viralimalai",
    "orderTotal": "₹110",
    "orderStatus": "Delivered",
    "orderDeliveryStatus": "delivered",
    "orderType": "regular",
    "orderedItems": "Chicken rice (1)",
    "orderedTime": "April 15, 12:55 PM",
    "isActiveOrder": false,
    "actions": [
     {
      "type": "PAST_ORDER_CTA_ENUM_REORDER",
      "priority": 1,
      "title": "REORDER",
      "isEnabled": true,
      "reorderMeta": {
       "orderItems": [
        {
         "itemId": "182051004",
         "name": "Chicken rice",
         "isVeg": "0",
         "quantity": "1",
         "total": "174",
         "subtotal": "174",
         "packingCharges": "0",
         "categoryDetails": {
          "category": "Fried Rice Varieties",
          "subCategory": "nota"
         },
         "attributes": {
          "portionSize": "0",
          "vegClassifier": "VEG_CLASSIFIER_NONVEG"
         }
        }
       ],
       "restaurantCoverImageId": "RX_THUMBNAIL/IMAGES/VENDOR/2026/1/20/95003306-b683-4e9c-a61a-bccee27ee0a8_1203761.jpg"
      }
     },
     {
      "type": "PAST_ORDER_CTA_ENUM_RATE_FOOD",
      "priority": 3,
      "title": "RATE FOOD",
      "isEnabled": true,
      "rateDeliveryMeta": {
       "ratingType": "restaurant",
       "ratingTitle": "Not available"
      }
     }
    ]
   }
  ],
  "total": 5
 }
}
```

## discover_events
args: `{"latitude": 12.9716, "longitude": 77.5946}`

```json
{
 "content": [
  {
   "type": "text",
   "text": "No events found near the selected location.\nLocation context: latitude=12.9716, longitude=77.5946. Preserve these exact values for downstream Scenes calls."
  }
 ],
 "structuredContent": {
  "events": [],
  "collectionChips": []
 }
}
```

## search_restaurants_dineout
args: `{"latitude": 12.9352, "longitude": 77.6245, "query": "Italian"}`

```json
{
 "content": [
  {
   "type": "text",
   "text": "Found 28 restaurant(s) matching \"Italian\", showing 10. 18 more available, call again with offset=10.\n1. Thyme and Whisk — North Indian, Italian | 4.3★ | ₹1000 for two | Jayanagar (ID: 818805)\n2. Maya — North Indian, Italian | 4.4★ | ₹1500 for two | Jayanagar (ID: 1195459)\n3. Harley's Fine Baking — Desserts, Italian | 4.7★ | ₹900 for two | JP Nagar (ID: 883474)\n4. Si Nonna's Original Sourdough Pizza — Italian, Pizza | 4.8★ | ₹1000 for two | Koramangala (ID: 1032642)\n5. Toscano — Continental, Italian | 4.3★ | ₹1800 for two | Koramangala (ID: 24699)\n6. Baci Baci Osteria — Italian, Desserts | 4.8★ | ₹3400 for two | Koramangala (ID: 1450311)\n7. Euphoria Cafe — Italian, Ice Cream | 4.7★ | ₹500 for two | Koramangala (ID: 1373592)\n8. Brik Oven - Woodfired Pizza's — Pizza, Italian | 4.7★ | ₹1200 for two | JP Nagar (ID: 1373332)\n9. Light Of Italy — Italian, Mexican | 4.7★ | ₹1000 for two | HSR Layout (ID: 803398)\n10. Aroma and Crave — Italian, Continental | 5.0★ | ₹400 for two | Koramangala  (ID: 1133390)\nSearch coordinates: latitude=12.9352, longitude=77.6245 (use these for get_restaurant_details and downstream calls).\n\nWhen the user selects a restaurant (by name, number, or clicking), call get_restaurant_details with that restaurant's ID and the same latitude/longitude. Do NOT call search_restaurants_dineout again.\n\nThese results are NOT yet shown to the user. Decide which restaurants to show and in what order based on the user's intent (cheapest → cost, best → rating, nearest → distance, else relevance), then call render_restaurants_dineout with restaurantIds in that order plus searches listing every search you ran ({ query, latitude, longitude, entityType? }). ids may span multiple searches."
  }
 ],
 "structuredContent": {}
}
```

## search_restaurants_dineout
args: `{"latitude": 12.9352, "longitude": 77.6245, "query": "Koramangala"}`

```json
{
 "content": [
  {
   "type": "text",
   "text": "Found 28 restaurant(s) matching \"Koramangala\", showing 10. 18 more available, call again with offset=10.\n1. QUARTER PETER — Bar Food, Multi Cuisine | 3.8★ | ₹1100 for two | Koramangala (ID: 1373139)\n2. The Pizza Bakery - Koramangala — Desserts,  | 4.6★ | ₹1500 for two | Koramangala (ID: 728469)\n3. Yuki — Japanese, Asian | 4.5★ | ₹1600 for two | Koramangala (ID: 693811)\n4. Sky Garden Bar And Kitchen — Bar Food, Multi Cuisine | 4.3★ | ₹1400 for two | Koramangala (ID: 1262104)\n5. Go Native — South Indian, North Indian | 4.8★ | ₹1700 for two | Koramangala (ID: 1399764)\n6. Brau Galie Micro Brewery & Pub — Bar Food, Asian | --★ | ₹1000 for two | Koramangala (ID: 1075087)\n7. Chin Lung Resto Bar - Koramangala — Bar Food, Multi Cuisine | 4.2★ | ₹1200 for two | Koramangala (ID: 673946)\n8. Brik Oven - Woodfired Pizza's — Pizza, Continental | 4.6★ | ₹1200 for two | Koramangala (ID: 321012)\n9. Sunshine Cafe by TBC — Continental, American | 4.7★ | ₹600 for two | Koramangala (ID: 974859)\n10. Drava Bar & Kitchen — Bar Food, Multi Cuisine | 4.0★ | ₹1500 for two | Koramangala (ID: 595606)\nSearch coordinates: latitude=12.9352, longitude=77.6245 (use these for get_restaurant_details and downstream calls).\n\nWhen the user selects a restaurant (by name, number, or clicking), call get_restaurant_details with that restaurant's ID and the same latitude/longitude. Do NOT call search_restaurants_dineout again.\n\nThese results are NOT yet shown to the user. Decide which restaurants to show and in what order based on the user's intent (cheapest → cost, best → rating, nearest → distance, else relevance), then call render_restaurants_dineout with restaurantIds in that order plus searches listing every search you ran ({ query, latitude, longitude, entityType? }). ids may span multiple searches."
  }
 ],
 "structuredContent": {}
}
```

## get_available_slots
args: `{"restaurantId": "1032642", "date": "2026-10-23", "latitude": 12.9352, "longitude": 77.6245}`

```json
{
 "_meta": {
  "slots": [
   {
    "displayTime": "11:00 AM",
    "slotGroupName": "Breakfast",
    "subText": "15% off",
    "daySubtext": "15% off",
    "dateStr": "2026-10-23",
    "reservationTime": "1792733400",
    "deals": [
     {
      "itemId": "1032642-1145157",
      "slotId": 1,
      "isFree": false,
      "title": "Flat 15% off on Total Bill",
      "bookingPrice": 25,
      "dealCategory": "GIRF",
      "discountPercentage": 15
     }
    ]
   },
   {
    "displayTime": "11:15 AM",
    "slotGroupName": "Breakfast",
    "subText": "15% off",
    "daySubtext": "15% off",
    "dateStr": "2026-10-23",
    "reservationTime": "1792734300",
    "deals": [
     {
      "itemId": "1032642-1145157",
      "slotId": 1,
      "isFree": false,
      "title": "Flat 15% off on Total Bill",
      "bookingPrice": 25,
      "dealCategory": "GIRF",
      "discountPercentage": 15
     }
    ]
   },
   {
    "displayTime": "11:30 AM",
    "slotGroupName": "Breakfast",
    "subText": "15% off",
    "daySubtext": "15% off",
    "dateStr": "2026-10-23",
    "reservationTime": "1792735200",
    "deals": [
     {
      "itemId": "1032642-1145157",
      "slotId": 1,
      "isFree": false,
      "title": "Flat 15% off on Total Bill",
      "bookingPrice": 25,
      "dealCategory": "GIRF",
      "discountPercentage": 15
     }
    ]
   },
   {
    "displayTime": "11:45 AM",
    "slotGroupName": "Breakfast",
    "subText": "15% off",
    "daySubtext": "15% off",
    "dateStr": "2026-10-23",
    "reservationTime": "1792736100",
    "deals": [
     {
      "itemId": "1032642-1145157",
      "slotId": 1,
      "isFree": false,
      "title": "Flat 15% off on Total Bill",
      "bookingPrice": 25,
      "dealCategory": "GIRF",
      "discountPercentage": 15
     }
    ]
   },
   {
    "displayTime": "12:00 PM",
    "slotGroupName": "Lunch",
    "subText": "15% off",
    "daySubtext": "15% off",
    "dateStr": "2026-10-23",
    "reservationTime": "1792737000",
    "deals": [
     {
      "itemId": "1032642-58545",
      "slotId": 1,
      "isFree": true,
      "title": "Standard table booking",
      "bookingPrice": 0,
      "dealCategory": "RESERVATION"
     },
     {
      "itemId": "1032642-1145157",
      "slotId": 1,
      "isFree": false,
      "title": "Flat 15% off on Total Bill",
      "bookingPrice": 25,
      "dealCategory": "GIRF",
      "discountPercentage": 15
     }
    ]
   },
   {
    "displayTime": "12:15 PM",
    "slotGroupName": "Lunch",
    "subText": "15% off",
    "daySubtext": "15% off",
    "dateStr": "2026-10-23",
    "reservationTime": "1792737900",
    "deals": [
     {
      "itemId": "1032642-58545",
      "slotId": 1,
      "isFree": true,
      "title": "Standard table booking",
      "bookingPrice": 0,
      "dealCategory": "RESERVATION"
     },
     {
      "itemId": "1032642-1145157",
      "slotId": 1,
      "isFree": false,
      "title": "Flat 15% off on Total Bill",
      "bookingPrice": 25,
      "dealCategory": "GIRF",
      "discountPercentage": 15
     }
    ]
   },
   {
    "displayTime": "12:30 PM",
    "slotGroupName": "Lunch",
    "subText": "15% off",
    "daySubtext": "15% off",
    "dateStr": "2026-10-23",
    "reservationTime": "1792738800",
    "deals": [
     {
      "itemId": "1032642-58545",
      "slotId": 1,
      "isFree": true,
      "title": "Standard table booking",
      "bookingPrice": 0,
      "dealCategory": "RESERVATION"
     },
     {
      "itemId": "1032642-1145157",
      "slotId": 1,
      "isFree": false,
      "title": "Flat 15% off on Total Bill",
      "bookingPrice": 25,
      "dealCategory": "GIRF",
      "discountPercentage": 15
     }
    ]
   },
   {
    "displayTime": "12:45 PM",
    "slotGroupName": "Lunch",
    "subText": "15% off",
    "daySubtext": "15% off",
    "dateStr": "2026-10-23",
    "reservationTime": "1792739700",
    "deals": [
     {
      "itemId": "1032642-58545",
      "slotId": 1,
      "isFree": true,
      "title": "Standard table booking",
      "bookingPrice": 0,
      "dealCategory": "RESERVATION"
     },
     {
      "itemId": "1032642-1145157",
      "slotId": 1,
      "isFree": false,
      "title": "Flat 15% off on Total Bill",
      "bookingPrice": 25,
      "dealCategory": "GIRF",
      "discountPercentage": 15
     }
    ]
   },
   {
    "displayTime": "01:00 PM",
    "slotGroupName": "Lunch",
    "subText": "15% off",
    "daySubtext": "15% off",
    "dateStr": "2026-10-23",
    "reservationTime": "1792740600",
    "deals": [
     {
      "itemId": "1032642-58545",
      "slotId": 1,
      "isFree": true,
      "title": "Standard table booking",
      "bookingPrice": 0,
      "dealCategory": "RESERVATION"
     },
     {
      "itemId": "1032642-1145157",
      "slotId": 1,
      "isFree": false,
      "title": "Flat 15% off on Total Bill",
      "bookingPrice": 25,
      "dealCategory": "GIRF",
      "discountPercentage": 15
     }
    ]
   },
   {
    "displayTime": "01:15 PM",
    "slotGroupName": "Lunch",
    "subText": "15% off",
    "daySubtext": "15% off",
    "dateStr": "2026-10-23",
    "reservationTime": "1792741500",
    "deals": [
     {
      "itemId": "1032642-58545",
      "slotId": 1,
      "isFree": true,
      "title": "Standard table booking",
      "bookingPrice": 0,
      "dealCategory": "RESERVATION"
     },
     {
      "itemId": "1032642-1145157",
      "slotId": 1,
      "isFree": false,
      "title": "Flat 15% off on Total Bill",
      "bookingPrice": 25,
      "dealCategory": "GIRF",
      "discountPercentage": 15
     }
    ]
   },
   {
    "displayTime": "01:30 PM",
    "slotGroupName": "Lunch",
    "subText": "15% off",
    "daySubtext": "15% off",
    "dateStr": "2026-10-23",
    "reservationTime": "1792742400",
    "deals": [
     {
      "itemId": "1032642-58545",
      "slotId": 1,
      "isFree": true,
      "title": "Standard table booking",
      "bookingPrice": 0,
      "dealCategory": "RESERVATION"
     },
     {
      "itemId": "1032642-1145157",
      "slotId": 1,
      "isFree": false,
      "title": "Flat 15% off on Total Bill",
      "bookingPrice": 25,
      "dealCategory": "GIRF",
      "discountPercentage": 15
     }
    ]
   },
   {
    "displayTime": "01:45 PM",
    "slotGroupName": "Lunch",
    "subText": "15% off",
    "daySubtext": "15% off",
    "dateStr": "2026-10-23",
    "reservationTime": "1792743300",
    "deals": [
     {
      "itemId": "1032642-58545",
      "slotId": 1,
      "isFree": true,
      "title": "Standard table booking",
      "bookingPrice": 0,
      "dealCategory": "RESERVATION"
     },
     {
      "itemId": "1032642-1145157",
      "slotId": 1,
      "isFree": false,
      "title": "Flat 15% off on Total Bill",
      "bookingPrice": 25,
      "dealCategory": "GIRF",
      "discountPercentage": 15
     }
    ]
   },
   {
    "displayTime": "02:00 PM",
    "slotGroupName": "Lunch",
    "subText": "15% off",
    "daySubtext": "15% off",
    "dateStr": "2026-10-23",
    "reservationTime": "1792744200",
    "deals": [
     {
      "itemId": "1032642-58545",
      "slotId": 1,
      "isFree": true,
      "title": "Standard table booking",
      "bookingPrice": 0,
      "dealCategory": "RESERVATION"
     },
     {
      "itemId": "1032642-1145157",
      "slotId": 1,
      "isFree": false,
      "title": "Flat 15% off on Total Bill",
      "bookingPrice": 25,
      "dealCategory": "GIRF",
      "discountPercentage": 15
     }
    ]
   },
   {
    "displayTime": "02:15 PM",
    "slotGroupName": "Lunch",
    "subText": "15% off",
    "daySubtext": "15% off",
    "dateStr": "2026-10-23",
    "reservationTime": "1792745100",
    "deals": [
     {
      "itemId": "1032642-58545",
      "slotId": 1,
      "isFree": true,
      "title": "Standard table booking",
      "bookingPrice": 0,
      "dealCategory": "RESERVATION"
     },
     {
      "itemId": "1032642-1145157",
      "slotId": 1,
      "isFree": false,
      "title": "Flat 15% off on Total Bill",
      "bookingPrice": 25,
      "dealCategory": "GIRF",
      "discountPercentage": 15
     }
    ]
   },
   {
    "displayTime": "02:30 PM",
    "slotGroupName": "Lunch",
    "subText": "15% off",
    "daySubtext": "15% off",
    "dateStr": "2026-10-23",
    "reservationTime": "1792746000",
    "deals": [
     {
      "itemId": "1032642-58545",
      "slotId": 1,
      "isFree": true,
      "title": "Standard table booking",
      "bookingPrice": 0,
      "dealCategory": "RESERVATION"
     },
     {
      "itemId": "1032642-1145157",
      "slotId": 1,
      "isFree": false,
      "title": "Flat 15% off on Total Bill",
      "bookingPrice": 25,
      "dealCategory": "GIRF",
      "discountPercentage": 15
     }
    ]
   },
   {
    "displayTime": "02:45 PM",
    "slotGroupName": "Lunch",
    "subText": "15% off",
    "daySubtext": "15% off",
    "dateStr": "2026-10-23",
    "reservationTime": "1792746900",
    "deals": [
     {
      "itemId": "1032642-58545",
      "slotId": 1,
      "isFree": true,
      "title": "Standard table booking",
      "bookingPrice": 0,
      "dealCategory": "RESERVATION"
     },
     {
      "itemId": "1032642-1145157",
      "slotId": 1,
      "isFree": false,
      "title": "Flat 15% off on Total Bill",
      "bookingPrice": 25,
      "dealCategory": "GIRF",
      "discountPercentage": 15
     }
    ]
   },
   {
    "displayTime": "03:00 PM",
    "slotGroupName": "Lunch",
    "subText": "15% off",
    "daySubtext": "15% off",
    "dateStr": "2026-10-23",
    "reservationTime": "1792747800",
    "deals": [
     {
      "itemId": "1032642-58545",
      "slotId": 1,
      "isFree": true,
      "title": "Standard table booking",
      "bookingPrice": 0,
      "dealCategory": "RESERVATION"
     },
     {
      "itemId": "1032642-1145157",
      "slotId": 1,
      "isFree": false,
      "title": "Flat 15% off on Total Bill",
      "bookingPrice": 25,
      "dealCategory": "GIRF",
      "discountPercentage": 15
     }
    ]
   },
   {
    "displayTime": "03:15 PM",
    "slotGroupName": "Lunch",
    "subText": "15% off",
    "daySubtext": "15% off",
    "dateStr": "2026-10-23",
    "reservationTime": "1792748700",
    "deals": [
     {
      "itemId": "1032642-58545",
      "slotId": 1,
      "isFree": true,
      "title": "Standard table booking",
      "bookingPrice": 0,
      "dealCategory": "RESERVATION"
     },
     {
      "itemId": "1032642-1145157",
      "slotId": 1,
      "isFree": false,
      "title": "Flat 15% off on Total Bill",
      "bookingPrice": 25,
      "dealCategory": "GIRF",
      "discountPercentage": 15
     }
    ]
   },
   {
    "displayTime": "03:30 PM",
    "slotGroupName": "Lunch",
    "subText": "15% off",
    "daySubtext": "15% off",
    "dateStr": "2026-10-23",
    "reservationTime": "1792749600",
    "deals": [
     {
      "itemId": "1032642-58545",
      "slotId": 1,
      "isFree": true,
      "title": "Standard table booking",
      "bookingPrice": 0,
      "dealCategory": "RESERVATION"
     },
     {
      "itemId": "1032642-1145157",
      "slotId": 1,
      "isFree": false,
      "title": "Flat 15% off on Total Bill",
      "bookingPrice": 25,
      "dealCategory": "GIRF",
      "discountPercentage": 15
     }
    ]
   },
   {
    "displayTime": "03:45 PM",
    "slotGroupName": "Lunch",
    "subText": "15% off",
    "daySubtext": "15% off",
    "dateStr": "2026-10-23",
    "reservationTime": "1792750500",
    "deals": [
     {
      "itemId": "1032642-58545",
      "slotId": 1,
      "isFree": true,
      "title": "Standard table booking",
      "bookingPrice": 0,
      "dealCategory": "RESERVATION"
     },
     {
      "itemId": "1032642-1145157",
      "slotId": 1,
      "isFree": false,
      "title": "Flat 15% off on Total Bill",
      "bookingPrice": 25,
      "dealCategory": "GIRF",
      "discountPercentage": 15
     }
    ]
   },
   {
    "displayTime": "04:00 PM",
    "slotGroupName": "Lunch",
    "subText": "15% off",
    "daySubtext": "15% off",
    "dateStr": "2026-10-23",
    "reservationTime": "1792751400",
    "deals": [
     {
      "itemId": "1032642-1145157",
      "slotId": 1,
      "isFree": false,
      "title": "Flat 15% off on Total Bill",
      "bookingPrice": 25,
      "dealCategory": "GIRF",
      "discountPercentage": 15
     }
    ]
   },
   {
    "displayTime": "04:15 PM",
    "slotGroupName": "Lunch",
    "subText": "15% off",
    "daySubtext": "15% off",
    "dateStr": "2026-10-23",
    "reservationTime": "1792752300",
    "deals": [
     {
      "itemId": "1032642-1145157",
      "slotId": 1,
      "isFree": false,
      "title": "Flat 15% off on Total Bill",
      "bookingPrice": 25,
      "dealCategory": "GIRF",
      "discountPercentage": 15
     }
    ]
   },
   {
    "displayTime": "04:30 PM",
    "slotGroupName": "Lunch",
    "subText": "15% off",
    "daySubtext": "15% off",
    "dateStr": "2026-10-23",
    "reservationTime": "1792753200",
    "deals": [
     {
      "itemId": "1032642-1145157",
      "slotId": 1,
      "isFree": false,
      "title": "Flat 15% off on Total Bill",
      "bookingPrice": 25,
      "dealCategory": "GIRF",
      "discountPercentage": 15
     }
    ]
   },
   {
    "displayTime": "04:45 PM",
    "slotGroupName": "Lunch",
    "subText": "15% off",
    "daySubtext": "15% off",
    "dateStr": "2026-10-23",
    "reservationTime": "1792754100",
    "deals": [
     {
      "itemId": "1032642-1145157",
      "slotId": 1,
      "isFree": false,
      "title": "Flat 15% off on Total Bill",
      "bookingPrice": 25,
      "dealCategory": "GIRF",
      "discountPercentage": 15
     }
    ]
   },
   {
    "displayTime": "05:00 PM",
    "slotGroupName": "Dinner",
    "subText": "15% off",
    "daySubtext": "15% off",
    "dateStr": "2026-10-23",
    "reservationTime": "1792755000",
    "deals": [
     {
      "itemId": "1032642-58545",
      "slotId": 1,
      "isFree": true,
      "title": "Standard table booking",
      "bookingPrice": 0,
      "dealCategory": "RESERVATION"
     },
     {
      "itemI
... [truncated]
```


## render_restaurants_dineout (structuredContent, live)
args: `{"restaurantIds":["1032642","24699"],"searches":[{"query":"Italian","latitude":12.9352,"longitude":77.6245}]}`
```json
{"restaurants":[{"id":"1032642","name":"Si Nonna's Original Sourdough Pizza","cuisine":["Italian","Pizza"],"locality":"Koramangala","area":"Koramangala","rating":{"value":"4.8","count":1529},"costForTwo":"₹1000 for two","imageUrl":"https://media-assets.swiggy.com/swiggy/image/upload/DINEOUT_ALL_RESTAURANTS/IMAGES/RESTAURANT_IMAGE_SERVICE/2026/3/4/8ec61a8d-b479-4371-a358-113e030167f6_DSC00076Edit0bfbbde2997f4f0db55865b64328e339.JPG","distance":"1.3 km","highlights":["Reservation available","Free wifi","SwiggyPay accepted"],"offers":[{"offerTitle":"Flat 15% off","offerDescription":"Total bill"}],"offerHeadline":{"title":"Flat 15% off","kind":"deal","subtitle":"on pre-booking","subtext":"+1 offer","logoUrl":"https://dineout-media-assets.swiggy.com/swiggy/image/upload/dineout/new-rx-card/one_pre_booking.png","logoText":"ONE"},"bankOffers":[{"offerTitle":"Flat 15% off"}],"vendorHighlights":[{"type":"","text":"Table booking"}],"availableDeals":[]},{"id":"24699","name":"Toscano","cuisine":["Continental","Italian"],"locality":"Koramangala","area":"Nexus Koramangala Mall, Koramangala","rating":{"value":"4.3","count":2816},"costForTwo":"₹1800 for two","imageUrl":"https://media-assets.swiggy.com/swiggy/image/upload/DINEOUT_ALL_RESTAURANTS/IMAGES/RESTAURANT_IMAGE_SERVICE/2026/5/27/68179914-f600-45dd-93ae-1f42aaecdbd1_DSC006443c3103f6b394472cb32715d001e9f396.JPG","distance":"1.6 km","highlights":["Alcohol served","Reservation available","Parking available","Free wifi"],"offers":[],"offerHeadline":{"title":"Up to 10% off with bank offers","kind":"payment","logoUrl":"https://dineout-media-assets.swiggy.com/swiggy/image/upload/dineout/new-rx-card/pocket_hero.png"},"bankOffers":[],"vendorHighlights":[{"type":"","text":"Table booking"}],"availableDeals":[]}],"message":"Showing 2 restaurants.","latitude":12.9352,"longitude":77.6245}
```

## get_restaurant_details (structuredContent, live, image lists trimmed)
```json
{"restaurantId":"818431","restaurant":{"id":"818431","restaurantId":"818431","name":"Kling Brewery","cuisines":["Bar Food","Multi Cuisine"],"locality":"Sattva Auro, Church Street, Bangalore","area":"Sattva Auro, Church Street, Bangalore","address":"1.2 km • 27,Ground Floor, Sattva Auro, Church St ... 560001","avgRating":4.6,"costForTwo":"₹1600 for two","imageUrl":"https://media-assets.swiggy.com/...JPG","mastheadImageUrls":["https://...JPG","..."],"timings":"Open till 12:30AM","deals":[{"id":"","title":"Flat 20% off on Total Bill","description":"Available on Mon-Sun","discountPercentage":20,"coverCharge":0,"slotGroupName":"Pre-booking offers","offerCategory":"prebooking"}],"partnerType":"PR"},"offers":[{"id":"","title":"Flat 20% off on Total Bill","description":"Available on Mon-Sun","discountPercentage":20,"coverCharge":0,"slotGroupName":"Pre-booking offers","offerCategory":"prebooking"}],"menuImages":[{"imageUrl":"https://...png","label":"Page 1"}],"menuImageGroups":[{"title":"Bar • 3 pages","images":[{"imageUrl":"...","label":"Page 1"}]}],"amenities":["Alcohol served","Reservation available","Parking available","Valet parking","Free wifi","Pet friendly","Smoking area","SwiggyPay accepted"],"locationMapUrl":"https://www.google.com/maps/dir/?api=1&origin=12.9716,77.5946&destination=12.975062,77.601932&travelmode=driving","latitude":12.9716,"longitude":77.5946}
```

## scenes: discover_events (live) — EMPTY for Bangalore, Koramangala, Mumbai and with addressId
```json
{"events":[],"collectionChips":[]}
```
text: "No events found near the selected location."

## scenes: search_events (live) — WORKS; returns events across ALL cities (filter by `location` containing the user's city)
args: `{"query":"comedy","latitude":12.9716,"longitude":77.5946}`
```json
{"suggestions":[{"eventId":"100098766","eventName":"Air 1 Standup Comedy By Harshit Mahawar","location":"Khb Colony, Bangalore"},{"eventId":"100111962","eventName":"Indiranagar Comedy Nights Standup Show","location":"Indiranagar, Bangalore"},{"eventId":"100109009","eventName":"Standup Comedy Show Bangalore","location":"Hsr Layout, Bangalore"},{"eventId":"100121119","eventName":"Kharadi Comedy Nights Stand Up Comedy","location":"Kharadi, Pune"},{"eventId":"100104136","eventName":"Are You Wet Standup Comedy Show By Ink A Laugh","location":"Vile Parle West, Mumbai"}]}
```

## scenes: get_event_details (live)
```json
{"eventId":"100109009","eventName":"Standup Comedy Show Bangalore","venueId":"1233","venueName":"Bloom Creative Zone - HSR","area":"HSR Layout","formattedAddress":"Bloom Creative Zone - Hsr, Bangalore","venueLat":"12.90682","venueLng":"77.648935","upcomingDate":"23rd Oct • 10:00 PM onwards","price":""}
```
(no image field anywhere in Scenes responses)

## scenes: list_event_shows (live, one date group shown)
args: `{"eventId":"100109009","venueId":"1233","latitude":12.9716,"longitude":77.5946}`
```json
{"eventShowListing":{"dateSummary":[{"date":{"year":2026,"month":10,"day":23},"totalAvailableInventory":12,"status":"ENTITIES_DISCOVERY_STATE_ON_SALE"}],
 "venueDetails":[{"id":"1233","name":"Bloom Creative Zone - HSR","location":{"latLng":{"latitude":12.90682,"longitude":77.648935},"cityId":1},"address":"Bloom Creative Zone - HSR, 24th Main Road, ... Bengaluru","cityDisplayName":"Bangalore","localityDisplayName":"HSR Layout"}],
 "dateGroupedEventShow":[{"date":{"year":2026,"month":10,"day":23},"eventShow":[{"id":"100496062","name":"2026-10-23 16:30:00-2026-10-23 18:00:00","timeRange":{"startTime":"2026-10-23T16:30:00Z","endTime":"2026-10-23T18:00:00Z"},"eventId":"100109009","venue":{"type":"VENUE_TYPE_SPECIFIC","venueId":"1233","name":""},"maxAvailableInventory":12,
   "tickets":[{"id":"1223907","name":"Entry Pass For One","availableInventory":7,"price":{"price":{"currencyCode":"INR","units":"199","nanos":0},"discountedPrice":{"currencyCode":"INR","units":"199","nanos":0},"coverCharge":{"currencyCode":"INR","units":"0","nanos":0}},"tnc":"<ul><li>This pass admits 1 individual only</li></ul>","status":"ENTITIES_DISCOVERY_STATE_ON_SALE"},
              {"id":"1223908","name":"Entry Pass For Two","availableInventory":5,"price":{"price":{"currencyCode":"INR","units":"349","nanos":0},"discountedPrice":{"currencyCode":"INR","units":"349","nanos":0},"coverCharge":{"currencyCode":"INR","units":"0","nanos":0}},"status":"ENTITIES_DISCOVERY_STATE_ON_SALE"}],
   "purchaseRules":{"allowedCovers":{"min":1,"max":10},"allowedType":"TICKET_PURCHASE_ALLOWED_MULTIPLE_VARIANTS"},"status":"ENTITIES_DISCOVERY_STATE_ON_SALE","show_time_unix":1792773000,"show_time_ist":"Fri, 23 Oct, 10:00 pm"}]}],
 "eventInfo":{"id":"100109009","name":"Standup Comedy Show Bangalore","languages":["english","hindi","hinglish"],"ageGroup":"18 yrs+","eventDuration":{"type":"TYPE_HOURS","value":1},"tags":["Stand Up Comedy","Open Mic Comedy","Late Night"],"recurring":true}},
 "status":{"code":0,"message":"Success"}}
```

## scenes: get_saved_locations (live)
```json
{"locations":[{"index":3,"id":"d1k9ctrdq1ocsktt0090__AMXrgASg728rGDWKq4_ky_","addressLine":"... New Tippasandra, Bengaluru, Karnataka, India","addressCategory":"Other","addressTag":"GPR"}]}
```

## Instamart get_cart: bound address id is SHORT
`selectedAddress: "db7kh1c1d96ofdam8g8g"` vs get_addresses id `"db7kh1c1d96ofdam8g8g__AMVEDwTGeS8WPRJQbO-o12"` → compare with `sameAddressId()` (src/backend/mcp/swiggy-mcp.ts).
