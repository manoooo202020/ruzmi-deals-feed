# RUZMI Hot Deals Feed (`$0` Forever)

مستودع تجميع ونشر العروض الساخنة المجاني لتطبيق **RUZMI** عبر **GitHub Actions + GitHub Pages** بدون أي خوادم مدفوعة أو تبعيات خارجية (`Node.js 20+` خالص).

## روابط العروض المباشرة (GitHub Pages)

- **الفهرس العام:** https://manoooo202020.github.io/ruzmi-deals-feed/deals/index.json
- **قالب تطبيق RUZMI:** `https://manoooo202020.github.io/ruzmi-deals-feed/deals/{REGION}.json`
- **مصر:** https://manoooo202020.github.io/ruzmi-deals-feed/deals/EG.json
- **العالمي:** https://manoooo202020.github.io/ruzmi-deals-feed/deals/GLOBAL.json

يدعم جميع المناطق الـ 19 المعتمدة في التطبيق:
`EG, SA, AE, KW, QA, JO, MA, US, GB, DE, FR, ES, IT, TR, IN, BR, JP, RU, GLOBAL`.

## التحديث التلقائي، المزامنة المزدوجة (Supabase + GitHub Pages)، وحماية الخصومات

- يعمل Workflow التحديث (`.github/workflows/update-deals.yml`) تلقائياً **كل 6 ساعات** (`0 */6 * * *`) أو عند التشغيل اليدوي (`workflow_dispatch`) أو عند أي تعديل على فرع `main`.
- يزامن الصفقات الموثّقة ثنائياً مع قاعدة بيانات **Supabase (`public.hot_deals` و`public.deal_price_ledger`)** مع الحفاظ الكامل على أي عروض مضافة يدوياً من لوحة Supabase (`is_manual = true`) ودمجها تلقائياً في ملفات **GitHub Pages**، مع إبراز صفقات `70%–90%` بوسم `dealTier: "mega"`.
- يحفظ سجل الأسعار التاريخي في `data/price-ledger.json` و`deal_price_ledger` لرفض أي تضخيم وهمي للسعر الأصلي والتحقق الرياضي (`5%–95%`) واستبعاد العروض المنتهية تلقائياً.

## إضافة عروض يدوية (هايبر ماركت / مطاعم / عروض فلاش) في ثوانٍ

افتح ملف `data/manual-deals.json` من واجهة GitHub واضغط **Edit** وأضف عنصراً داخل مصفوفة `"deals"` ثم احفظ (`Commit changes`)، وسينشره GitHub Actions تلقائياً خلال دقيقة دون أي تحديث لتطبيق RUZMI:

```json
{
  "title": "عرض زيت عباد شمس 2.2 لتر",
  "url": "https://example.com/offer/sunflower-oil",
  "storeName": "كارفور مصر",
  "region": "EG",
  "category": "grocery",
  "price": 179,
  "originalPrice": 285,
  "currency": "EGP",
  "couponCode": "SAVE10",
  "expiresAt": "2026-12-31T23:59:59Z"
}
```

### الحقول المدعومة في `manual-deals.json`
- **إلزامية:** `title`، `url` (بصيغة `https://`)، `storeName`، `region` (أحد رموز الدول الـ 19).
- **اختيارية:** `category` (`grocery | dining | electronics | fashion | home | beauty | digital | other`)، `price`، `originalPrice`، `currency`، `discountPercent`، `couponCode`، `expiresAt` (تاريخ ISO أو timestamp بالمللي ثانية)، `imageUrl` (صورة منتج `https://` فقط — بدون شعارات متاجر).

## التشغيل المحلي للاختبار

```bash
node scripts/collect-deals.mjs
```
