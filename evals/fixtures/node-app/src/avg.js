// Mean of a list of numbers; 0 for an empty list.
function avg(numbers) {
  if (numbers.length === 0) return 0;
  let total = 0;
  for (const n of numbers) total += n;
  return total / numbers.length;
}

module.exports = { avg };
