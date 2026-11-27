// Sunucuya göre düzenlenebilir örnek kelime listesi.
const badWords = ['amk', 'aq', 'oç', 'oc', 'siktir', 'orospu', 'piç', 'pic', 'yarrak'];
const inviteRegex = /(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)[\w-]+/i;
const adRegex = /\b(?:ucuz takipçi|bedava nitro|coin satışı)\b/i;
const spamRegex = /(.)\1{12,}/i;
function isFiltered(content) {
  const lower = content.toLocaleLowerCase('tr');
  return inviteRegex.test(content) || adRegex.test(lower) || spamRegex.test(content) ||
    badWords.some(word => word && lower.includes(word));
}
module.exports = { isFiltered };
