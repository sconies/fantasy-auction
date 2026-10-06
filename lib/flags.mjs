// The questions Jev answers about a piece of player text. Each answer is a probability (Jev "noul").
// `hint` is the stat we expect it to move; the fit (scripts/fit-flags.mjs) measures what it actually
// moves, against ESPN's projection misses in past seasons, and keeps only flags that predict out of season.

export const FLAGS = {
  // Availability
  absence: { group: 'availability', hint: 'games', q: 'says the player is expected to miss regular-season games because of an injury, illness, suspension or personal matter' },
  injury_history: { group: 'availability', hint: 'games', q: 'describes the player as injury-prone or mentions a history of missing games' },
  recovering: { group: 'availability', hint: 'games', q: 'says the player is recovering or returning from a significant injury or surgery' },
  minutes_limit: { group: 'availability', hint: 'minutes', q: 'says the player is or will be on a minutes restriction or a limited workload' },
  load_managed: { group: 'availability', hint: 'games', q: 'says the team will rest the player on back-to-backs or manage his load' },
  // Role
  starter: { group: 'role', hint: 'minutes', q: 'says the player is expected to start or has been named a starter' },
  bench: { group: 'role', hint: 'minutes', q: 'says the player is expected to come off the bench or has lost his starting job' },
  role_up: { group: 'role', hint: 'minutes', q: "says the player's role, minutes or opportunity should grow compared with last season" },
  role_down: { group: 'role', hint: 'minutes', q: "says the player's role, minutes or opportunity should shrink compared with last season" },
  competition: { group: 'role', hint: 'minutes', q: 'says the player faces competition for minutes or that his role is uncertain' },
  out_of_rotation: { group: 'role', hint: 'minutes', q: 'says the player may be out of the rotation or only a deep bench option' },
  new_team: { group: 'role', hint: 'minutes', q: 'says the player changed teams (traded, signed or claimed) since last season' },
  opening: { group: 'role', hint: 'usage', q: "says a teammate's absence or departure opens up opportunity for the player" },
  crowded: { group: 'role', hint: 'usage', q: "says the team added players who could take the player's shots or minutes" },
  // How he is used
  usage_up: { group: 'usage', hint: 'pts', q: 'says the player should take on a bigger scoring or offensive load (more shots or touches)' },
  playmaker: { group: 'usage', hint: 'ast', q: 'says the player will handle the ball or run the offense as a primary playmaker' },
  more_threes: { group: 'usage', hint: 'tpm', q: 'says the player is shooting more threes, expanding his range or improving as a shooter' },
  rim_big: { group: 'usage', hint: 'fg', q: 'describes the player as a rim-running or interior big man who scores near the basket' },
  stretch_big: { group: 'usage', hint: 'tpm', q: 'describes the player as a big man who shoots threes' },
  defender: { group: 'usage', hint: 'stl', q: 'highlights defense, steals or blocks as a strength of the player' },
  rebounder: { group: 'usage', hint: 'reb', q: 'highlights rebounding as a strength of the player' },
  // Shooting and mistakes
  poor_shooter: { group: 'shooting', hint: 'fg', q: 'says the player is an inefficient or poor shooter' },
  ft_weakness: { group: 'shooting', hint: 'ft', q: "mentions the player's free-throw shooting as a weakness" },
  turnovers: { group: 'shooting', hint: 'tov', q: 'mentions turnovers as a problem for the player' },
  // Career arc and context
  breakout: { group: 'arc', hint: 'minutes', q: 'says the player is young and expected to improve or break out' },
  decline: { group: 'arc', hint: 'minutes', q: 'says the player is aging, declining or past his peak' },
  conditioning: { group: 'arc', hint: 'none', q: 'mentions improved conditioning, weight loss or added strength' },
  contract_year: { group: 'arc', hint: 'none', q: 'says the player is in a contract year or playing for a new contract' },
  rebuilding_team: { group: 'context', hint: 'games', q: "says the player's team is rebuilding or may limit veterans' playing time late in the season" },
};

export const FLAG_KEYS = Object.keys(FLAGS);

// One Jev request per text, every flag at once. `player` names who the text is about.
export function jevQuestions() {
  return Object.fromEntries(FLAG_KEYS.map(k => [k, { type: 'noul', instructions: `Reading the text in \`text\` about the NBA player named in \`player\`, is it true that it ${FLAGS[k].q}?` }]));
}
