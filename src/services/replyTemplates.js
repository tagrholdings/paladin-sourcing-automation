/**
 * Textos prontos definidos pelo Matheus (ver docs/reply-playbook.md).
 * Mudou o texto? Mude aqui — o classificador so escolhe QUAL usar.
 */
const POSITIVE =
  "Great...would love to connect and discuss what that looks like. We'll reach out after patient hours? Looking forward to connecting..";

const IN_PERSON = 'Happy to facilitate an in-person meeting. Let me connect you with my partner who lives nearby';

const DETAILS = {
  // 1 = desconfianca/validade, 2 = quem e / qual empresa, 3 = como conseguiu o numero / qual pratica
  1: 'Thanks for the reply. I work with Menlo Dental Transitions and we work with practice owners looking to transition. My website is www.menlotransitions.com. You can find me, my partners and all of our listings there. I sense you might be trying to determine the validity to this text, completely understandable, and the best way to do that is jump on a call so we can discuss. Of course, no pressure whatsoever. Thx',
  2: 'Sure....I work with Menlo Dental Transitions. We represent sellers in most cases but can help with any part of a transition and have for a very long time.',
  3: 'Sure...we got your number from a publicly available list of practice owners. Would love to connect over the phone if interested? If not, I can remove your number.',
};

module.exports = { POSITIVE, IN_PERSON, DETAILS };
