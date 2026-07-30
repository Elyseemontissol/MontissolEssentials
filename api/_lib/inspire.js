// Static config for the "Inspiration" daily-post series. Each entry is a
// pre-designed inspirational panel (split from the source graphics in
// assets/Social/Inspire/). The `message` field is the text already burned
// into the image — the LLM uses it to write a complementary caption, not
// to repeat it.
//
// When all entries have been used the rotation stops; extend this array
// (and drop matching PNGs into assets/Social/Inspire/) to keep the series
// going.
export const INSPIRE_POSTS = [
  // ── First set: 6 panels split from Inspiration.png (4:5 portrait). ──
  {
    image: 'inspire-1.png',
    message: 'DREAM BIG. WORK HARD. STAY FOCUSED. MAKE IT HAPPEN.',
    visual: 'A person standing on a mountain summit watching the sunrise.',
  },
  {
    image: 'inspire-2.png',
    message: 'EXCELLENCE IS IN THE DETAILS. We don’t just clean spaces. We create better environments for people to thrive.',
    visual: 'Bright office skyline with icons for Janitorial Services, Facility Maintenance, Reliable Solutions, People Focused, and Results Driven.',
  },
  {
    image: 'inspire-3.png',
    message: 'SMALL EFFORTS. BIG IMPACT. Every task matters. Every person counts. Every day we make a difference.',
    visual: 'A glowing filament light bulb at night.',
  },
  {
    image: 'inspire-4.png',
    message: 'PROGRESS OVER PERFECTION. Keep moving forward. Keep improving. Keep ascending.',
    visual: 'Concrete wall with a bold upward chevron.',
  },
  {
    image: 'inspire-5.png',
    message: 'ONE STEP AT A TIME. ONE GOAL AT A TIME. WE RISE. Together, we build better every day.',
    visual: 'Silhouette climbing stairs at sunset with a city skyline behind. Plan It. Work It. Achieve It.',
  },
  {
    image: 'inspire-6.png',
    message: 'Your ENVIRONMENT Reflects Your STANDARDS. Let’s set the standard higher, together.',
    visual: 'Bold black and orange brushstrokes on a white background.',
  },

  // ── Second set: 10 panels split from Bold.png (letterboxed to 4:5). ──
  {
    image: 'bold-1.png',
    message: 'THE VIEW IS BETTER AFTER THE CLIMB. Keep going. Your future self is watching.',
    visual: 'A hiker standing on a rocky mountain summit at sunset with layered peaks behind.',
  },
  {
    image: 'bold-2.png',
    message: 'FOCUS ON THE SOLUTION, NOT THE OBSTACLE. Clear mind. Smart plan. Consistent action. Great results.',
    visual: 'FOCUS / SOLVE / EXECUTE / SUCCEED icons on a clean white background.',
  },
  {
    image: 'bold-3.png',
    message: 'BE PROUD OF THE WORK YOU DO. Clean spaces. Stronger teams. Better every day. We don’t just maintain facilities, we elevate environments.',
    visual: 'A brightly polished hallway with janitorial equipment.',
  },
  {
    image: 'bold-4.png',
    message: 'YOUR TODAY BUILDS YOUR TOMORROW. Invest in yourself. Stay consistent. The results will come.',
    visual: 'A person looking out at a city skyline at sunset.',
  },
  {
    image: 'bold-5.png',
    message: 'DISCIPLINE TODAY. FREEDOM TOMORROW. Show up. Do the work. Stay consistent. Keep improving.',
    visual: 'Dark textured background with four orange checkmarks listing the daily habits.',
  },
  {
    image: 'bold-6.png',
    message: 'GREAT SERVICE STARTS WITH A GREAT ATTITUDE. Respect everyone. Own your role. Deliver excellence. Make an impact. Good attitude. Strong team. Amazing results.',
    visual: 'A potted plant catching soft window light on a clean desk.',
  },
  {
    image: 'bold-7.png',
    message: 'EXCELLENCE IS A HABIT, NOT AN ACT. You don’t rise to the occasion. You fall to your level of training. Prepare. Train. Perform. Repeat.',
    visual: 'Close-up of interlocking industrial gears.',
  },
  {
    image: 'bold-8.png',
    message: 'NEW DAY. NEW OPPORTUNITIES. NEW POSSIBILITIES. Make today count. Wake up with purpose. Work with passion. Finish with pride. Be better than yesterday.',
    visual: 'A person on a mountain peak arms raised at sunrise.',
  },
  {
    image: 'bold-9.png',
    message: 'TEAMWORK MAKES THE DREAM WORK. Alone we can do so little. Together we can do so much.',
    visual: 'One climber reaching down to pull another up a rocky ridge at golden hour.',
  },
  {
    image: 'bold-10.png',
    message: 'QUALITY TODAY. TRUST FOREVER. We do it right. Even when no one is watching. Quality. Integrity. Accountability.',
    visual: 'A shield with a checkmark surrounded by embers, with quality / integrity / accountability icons below.',
  },
];

// Redis keys used by the inspire rotation.
export const INSPIRE_KEYS = {
  next: 'inspire:next',                             // integer counter, 0-based, next index to post
  exhaustedNotified: 'inspire:exhausted_notified',  // '1' once the "add more" alert has been sent
};
