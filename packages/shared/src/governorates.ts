export interface Governorate {
  code: string;
  nameAr: string;
  nameEn: string;
}

export const GOVERNORATES: readonly Governorate[] = [
  { code: 'CAI', nameAr: 'القاهرة', nameEn: 'Cairo' },
  { code: 'GIZ', nameAr: 'الجيزة', nameEn: 'Giza' },
  { code: 'ALX', nameAr: 'الإسكندرية', nameEn: 'Alexandria' },
  { code: 'QLY', nameAr: 'القليوبية', nameEn: 'Qalyubia' },
  { code: 'SHR', nameAr: 'الشرقية', nameEn: 'Sharqia' },
  { code: 'DKH', nameAr: 'الدقهلية', nameEn: 'Dakahlia' },
  { code: 'GHR', nameAr: 'الغربية', nameEn: 'Gharbia' },
  { code: 'MNF', nameAr: 'المنوفية', nameEn: 'Monufia' },
  { code: 'BHR', nameAr: 'البحيرة', nameEn: 'Beheira' },
  { code: 'KFS', nameAr: 'كفر الشيخ', nameEn: 'Kafr El Sheikh' },
  { code: 'DMT', nameAr: 'دمياط', nameEn: 'Damietta' },
  { code: 'PTS', nameAr: 'بورسعيد', nameEn: 'Port Said' },
  { code: 'ISM', nameAr: 'الإسماعيلية', nameEn: 'Ismailia' },
  { code: 'SUZ', nameAr: 'السويس', nameEn: 'Suez' },
  { code: 'FYM', nameAr: 'الفيوم', nameEn: 'Faiyum' },
  { code: 'BNS', nameAr: 'بني سويف', nameEn: 'Beni Suef' },
  { code: 'MNY', nameAr: 'المنيا', nameEn: 'Minya' },
  { code: 'AST', nameAr: 'أسيوط', nameEn: 'Asyut' },
  { code: 'SOH', nameAr: 'سوهاج', nameEn: 'Sohag' },
  { code: 'QEN', nameAr: 'قنا', nameEn: 'Qena' },
  { code: 'LXR', nameAr: 'الأقصر', nameEn: 'Luxor' },
  { code: 'ASN', nameAr: 'أسوان', nameEn: 'Aswan' },
  { code: 'RSS', nameAr: 'البحر الأحمر', nameEn: 'Red Sea' },
  { code: 'WAD', nameAr: 'الوادي الجديد', nameEn: 'New Valley' },
  { code: 'MAT', nameAr: 'مطروح', nameEn: 'Matrouh' },
  { code: 'NSN', nameAr: 'شمال سيناء', nameEn: 'North Sinai' },
  { code: 'SSN', nameAr: 'جنوب سيناء', nameEn: 'South Sinai' },
];

export const GOVERNORATE_CODES = GOVERNORATES.map((g) => g.code) as [string, ...string[]];

export function isGovernorateCode(code: string): boolean {
  return GOVERNORATES.some((g) => g.code === code);
}
