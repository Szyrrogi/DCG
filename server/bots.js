// Przeciwnicy komputerowi: bossowie z zakładki Przygoda i bot treningowy.
'use strict';

const BOTS = {
  casborg: {
    id: 'casborg', kind: 'adventure', order: 1,
    name: 'Cas-Borg', avatar: 'c:Cas-Borg',
    title: 'Cyborg z 40 zdrowia',
    rule: 'Zaczyna z 40 zdrowia.',
    blurb: 'Pali własne zdrowie, żeby dobierać karty i palić Twoją twarz. Z Mocą pieśni SzyRRogiego jego remiksy zadają po 8.',
    hp: 40,
    deck: [
      'Eva', 'Eva', 'Eva',
      'Moja Przygoda (Remix)', 'Moja Przygoda (Remix)', 'Moja Przygoda (Remix)',
      'Diss na taksówkarzy', 'Diss na taksówkarzy',
      'Kubba', 'Kubba', 'SzyRRogi',
      'Widz z devszyr', 'Widz z devszyr', 'Widz z devszyr',
      'Ksawery', 'Ksawery', 'Cas-Borg',
      'Bedoes z Tarczą', 'Bedoes z Tarczą', 'Jade Jade Jade',
    ],
  },
  kunner: {
    id: 'kunner', kind: 'adventure', order: 2,
    name: 'Kunner', avatar: 'f7',
    title: 'Egzekutor',
    rule: 'W swojej pierwszej turze rzuca „Wyrok Kunnera”: Twoje zdrowie spada do 6.',
    blurb: 'Najszybsza talia w grze: tanie dissy, szarża i Moc pieśni. Masz kilka tur, zanim Cię dobije.',
    openingSpell: 'Wyrok Kunnera',
    deck: [
      'Diss na Szymona', 'Diss na Szymona', 'Diss na Szymona',
      'Moja Przygoda (Remix)', 'Moja Przygoda (Remix)', 'Moja Przygoda (Remix)',
      'Jade Jade Jade', 'Jade Jade Jade', 'Jade Jade Jade',
      'Diss na taksówkarzy', 'Diss na taksówkarzy', 'Diss na taksówkarzy',
      'Kubba', 'Kubba', 'Tael',
      'Runia', 'Runia', 'Lian', 'Lian', 'Błażej',
    ],
  },
  tczew: {
    id: 'tczew', kind: 'adventure', order: 3,
    name: 'Baron Tczewa', avatar: 'c:Olaf',
    title: 'Pan na trzech kulach',
    rule: 'Zaczyna z 3 kulami many Tczewa.',
    blurb: 'Od pierwszej tury stawia ciężkie jednostki, a potem dorzuca same potwory z końca krzywej.',
    startMana: { T: 3 },
    deck: [
      'Błażej', 'Dis', 'Olaf', 'Agnieszka', 'SzyRRogi', 'Xayoo', 'Lazarus', 'Kayle', 'Jędrek',
      '67', '67', 'Kamikaze', 'Kamikaze',
      'Oczekiwania', 'Oczekiwania', 'Jestem zmęczony za bardzo', 'Jestem zmęczony za bardzo',
      'Szymon', 'Julka', 'Julka',
    ],
  },
  trener: {
    id: 'trener', kind: 'training', order: 4,
    name: 'Trener', avatar: 'f8',
    title: 'Bot treningowy',
    rule: 'Zwykłe zasady, zwykła talia kontrolna.',
    blurb: 'Prowokacje, leczenie i usuwanie jednostek. Dobry sparing przed prawdziwymi meczami.',
    deck: [
      'Bedoes z Tarczą', 'Bedoes z Tarczą', 'Bedoes z Tarczą', 'Ramus', 'Ramus',
      'Yeager', 'Yeager', 'Yeager', 'Gdy Zapada Noc', 'Kayle',
      'Oczekiwania', 'Oczekiwania', 'Jestem zmęczony za bardzo', 'Jestem zmęczony za bardzo',
      'Karo As', 'Karo As', ':pp', ':pp', 'Wieczni Chłodne Dłonie', '67',
    ],
  },
};

const REWARDS = { adventure: { win: 10, first: 30 }, training: { win: 5, first: 5 } };

function botSeat(bot) {
  return {
    userId: 'bot:' + bot.id, name: bot.name, avatar: bot.avatar, deck: bot.deck.slice(), isBot: true,
    hp: bot.hp, startMana: bot.startMana, openingSpell: bot.openingSpell,
  };
}

function publicBots() {
  return Object.values(BOTS).sort((a, b) => a.order - b.order).map(b => ({
    id: b.id, kind: b.kind, name: b.name, avatar: b.avatar, title: b.title, rule: b.rule, blurb: b.blurb,
    reward: REWARDS[b.kind], showcase: [...new Set(b.deck)].slice(0, 6),
  }));
}

module.exports = { BOTS, REWARDS, botSeat, publicBots };
