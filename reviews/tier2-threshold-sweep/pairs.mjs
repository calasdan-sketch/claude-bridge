// Hand-labeled evaluation set for the edge-similarity threshold sweep
// (I-HIGH-1). 150 pairs of OneMemory-style note texts (title + body, the
// same concatenation the edge graph scores).
//
// Labeling rule (applied consistently, by topic sameness, NOT by token
// overlap): label 1 = an agent reading one note would genuinely benefit
// from being shown the other as "related" (same topic / project / event /
// entity). label 0 = different topics, even when they share tokens.
//
// Deliberately included hard cases:
//   - positives with ZERO shared content tokens (61, 63, 64, 65, 68, 69):
//     no token metric can catch these; they bound the achievable recall.
//   - shared-token traps (106-125, 146-150): different topics sharing 1-2
//     common tokens — the exact failure mode of raw-TF cosine at 0.35.
//   - shared boilerplate (126-135): same template, different content.
//
// The sweep script (sweep.mjs) scores every pair with TF-IDF cosine using
// IDF from all 300 texts as the corpus, then sweeps thresholds 0.15-0.60
// and picks the F1 knee.

export const PAIRS = [
  // --- Exact duplicates (label 1) ---
  { a: "Buy milk, eggs, and bread", b: "Buy milk, eggs, and bread", label: 1 },
  { a: "Team standup at 9am in the main conference room", b: "Team standup at 9am in the main conference room", label: 1 },
  { a: "Mom's birthday is March 14th, get flowers", b: "Mom's birthday is March 14th, get flowers", label: 1 },
  { a: "Deploy the api server with the new config", b: "Deploy the api server with the new config", label: 1 },
  { a: "Call the plumber about the kitchen sink leak", b: "Call the plumber about the kitchen sink leak", label: 1 },
  { a: "Renew car insurance before Friday", b: "Renew car insurance before Friday", label: 1 },
  { a: "Water the plants while we're away this weekend", b: "Water the plants while we're away this weekend", label: 1 },
  { a: "Pick up dry cleaning on Thursday afternoon", b: "Pick up dry cleaning on Thursday afternoon", label: 1 },

  // --- Near duplicates, reworded (label 1) ---
  { a: "Dentist appointment Thursday at 2pm", b: "Dentist appointment on Thursday at two in the afternoon", label: 1 },
  { a: "Buy milk eggs bread from the store", b: "Pick up milk, eggs, and bread at the grocery store", label: 1 },
  { a: "Flight AC1234 departs 6am terminal 2", b: "Flight AC1234 leaves at 6 in the morning from terminal two", label: 1 },
  { a: "Mom's birthday March 14 get flowers", b: "Get flowers for mom, her birthday is March fourteenth", label: 1 },
  { a: "Deploy checklist: backup database, run migrations, restart api", b: "Deployment steps: back up the database, apply migrations, restart the api server", label: 1 },
  { a: "Call plumber about kitchen sink leak", b: "Phone the plumber regarding the leak in the kitchen sink", label: 1 },
  { a: "Renew car insurance before Friday deadline", b: "Car insurance renewal is due before Friday", label: 1 },
  { a: "Water plants this weekend while away", b: "While we are away this weekend, water the houseplants", label: 1 },
  { a: "Pick up dry cleaning Thursday afternoon", b: "Collect the dry cleaning on Thursday in the afternoon", label: 1 },
  { a: "Meeting with Sarah about Q3 budget at noon", b: "Noon meeting with Sarah to discuss the third quarter budget", label: 1 },
  { a: "Server migration scheduled for Sunday midnight", b: "The server migration is planned for midnight on Sunday", label: 1 },
  { a: "Submit expense report by end of month", b: "Expense reports are due by the end of the month", label: 1 },
  { a: "Gym session with trainer Tuesday 6pm", b: "Tuesday at six in the evening: gym session with the personal trainer", label: 1 },
  { a: "Order new laptop charger, USB-C 65W", b: "Buy a replacement USB-C 65 watt laptop charger", label: 1 },
  { a: "Cancel the old gym membership today", b: "Today: cancel my old gym membership", label: 1 },
  { a: "Book hotel in Toronto for the conference", b: "Reserve a Toronto hotel for the conference trip", label: 1 },
  { a: "Pay the electricity bill before the 15th", b: "Electricity bill payment due before the fifteenth", label: 1 },
  { a: "Vet appointment for Biscuit on Monday", b: "Take Biscuit to the vet on Monday", label: 1 },
  { a: "Change the furnace filter this month", b: "Replace the furnace filter sometime this month", label: 1 },
  { a: "Back up the photo library to the NAS", b: "Copy the photo library over to the NAS as a backup", label: 1 },

  // --- Same topic, substantial overlap (label 1) ---
  { a: "Q3 budget review meeting Thursday", b: "Thursday meeting to review the quarterly budget numbers with finance", label: 1 },
  { a: "Sourdough starter feeding schedule", b: "Feed the sourdough starter every twelve hours, keep it on the counter", label: 1 },
  { a: "Sourdough starter smells like acetone", b: "The sourdough starter has an acetone smell, needs more frequent feeding", label: 1 },
  { a: "Kubernetes cluster upgrade to 1.29", b: "Upgrade the k8s cluster to version one twenty nine next maintenance window", label: 1 },
  { a: "Postgres replication lag on the read replica", b: "The read replica is lagging behind postgres primary, investigate wal", label: 1 },
  { a: "Invoice #1042 from Acme Plumbing overdue", b: "Acme Plumbing invoice ten forty two is past due, follow up", label: 1 },
  { a: "Kids soccer practice moved to field 3", b: "Soccer practice for the kids is now on field three", label: 1 },
  { a: "New tires for the truck before winter", b: "Get winter tires installed on the truck", label: 1 },
  { a: "Roof shingles damaged after hailstorm", b: "The hailstorm damaged several roof shingles, call insurance", label: 1 },
  { a: "Book recommendation: Project Hail Mary", b: "Reading Project Hail Mary, great book so far", label: 1 },
  { a: "WiFi keeps dropping in the basement", b: "The basement wifi connection drops constantly", label: 1 },
  { a: "Dog groomer appointment Saturday", b: "Saturday appointment at the dog groomer for Biscuit", label: 1 },
  { a: "Refinance the mortgage, rates dropped", b: "Mortgage rates have dropped, look into refinancing", label: 1 },
  { a: "Oil change due at 80000 km", b: "The car needs an oil change at eighty thousand kilometers", label: 1 },
  { a: "Camping trip to Banff in August", b: "Plan the August camping trip to Banff national park", label: 1 },
  { a: "New recipe: lemon garlic chicken", b: "Tried the lemon garlic chicken recipe, needs more garlic", label: 1 },
  { a: "Lawn mower blade needs sharpening", b: "Sharpen the lawnmower blade this weekend", label: 1 },
  { a: "Password manager family plan renewal", b: "Renew the family plan for the password manager", label: 1 },
  { a: "Basement flooding after heavy rain", b: "Heavy rain caused water in the basement, check the sump pump", label: 1 },
  { a: "Flight delayed two hours, gate B12", b: "Our flight is delayed by two hours at gate B twelve", label: 1 },
  { a: "Wine tasting event downtown Friday", b: "Downtown wine tasting on Friday evening", label: 1 },
  { a: "Kids dentist checkup in June", b: "Schedule the kids dental checkup for June", label: 1 },
  { a: "New running shoes, size 10", b: "Buy running shoes in size ten", label: 1 },
  { a: "Tax documents for the accountant", b: "Gather tax documents to send to the accountant", label: 1 },
  { a: "Garage door opener battery dead", b: "The garage door opener needs a new battery", label: 1 },
  { a: "Snow blower maintenance before December", b: "Service the snowblower before December", label: 1 },
  { a: "Anniversary dinner reservation at 7", b: "Book the anniversary dinner for seven pm", label: 1 },
  { a: "Laptop screen flickering issue", b: "The laptop screen keeps flickering", label: 1 },
  { a: "Houseplant repotting this spring", b: "Repot the houseplants in the spring", label: 1 },
  { a: "Car detailing appointment next week", b: "Get the car detailed next week", label: 1 },

  // --- Hard positives, minimal overlap (label 1) ---
  { a: "Dentist appointment", b: "see dentist thursday", label: 1 },
  { a: "Call Alice", b: "Phone Alice tomorrow morning", label: 1 },
  { a: "Deploy the api", b: "Ship the backend to production", label: 1 },
  { a: "Buy birthday gift for Dan", b: "Dan's birthday present: whiskey stones", label: 1 },
  { a: "Fix the leaky faucet", b: "Plumber coming Tuesday for the tap", label: 1 },
  { a: "Morning run", b: "Jogged 5k at sunrise", label: 1 },
  { a: "Pay rent", b: "E-transfer landlord the monthly payment", label: 1 },
  { a: "Water heater pilot light out", b: "No hot water, check the heater", label: 1 },
  { a: "Team lunch Friday", b: "Friday lunch with the team at the deli", label: 1 },
  { a: "Bake sourdough", b: "Bread is in the oven", label: 1 },
  { a: "Car won't start", b: "Dead battery, need a boost", label: 1 },
  { a: "Flight cancelled", b: "Rebooked on the morning flight", label: 1 },

  // --- Different topics, no shared content tokens (label 0) ---
  { a: "Buy milk and eggs", b: "Deploy the api server tonight", label: 0 },
  { a: "Dentist appointment Thursday", b: "Water the garden beds", label: 0 },
  { a: "Call the plumber about the sink", b: "Book flights to Vancouver", label: 0 },
  { a: "Renew car insurance", b: "Bake sourdough bread", label: 0 },
  { a: "Team standup at nine", b: "Grocery list for the week", label: 0 },
  { a: "Server migration Sunday", b: "Kids soccer practice", label: 0 },
  { a: "Pay electricity bill", b: "Dog groomer Saturday", label: 0 },
  { a: "Oil change at eighty thousand", b: "Wine tasting downtown", label: 0 },
  { a: "Camping trip to Banff", b: "Password manager renewal", label: 0 },
  { a: "Lemon garlic chicken recipe", b: "Roof shingles hail damage", label: 0 },
  { a: "Lawn mower blade sharpening", b: "Flight delayed two hours", label: 0 },
  { a: "Basement flooding heavy rain", b: "Anniversary dinner at seven", label: 0 },
  { a: "Laptop screen flickering", b: "Houseplant repotting spring", label: 0 },
  { a: "Car detailing next week", b: "Snow blower maintenance", label: 0 },
  { a: "Mortgage refinance rates", b: "Vet appointment Biscuit", label: 0 },
  { a: "Invoice from Acme Plumbing", b: "Book recommendation Project Hail Mary", label: 0 },
  { a: "WiFi dropping basement", b: "Tax documents accountant", label: 0 },
  { a: "Garage door battery", b: "New running shoes size ten", label: 0 },
  { a: "Kids dentist June", b: "Change furnace filter", label: 0 },
  { a: "Back up photo library NAS", b: "Cancel gym membership", label: 0 },
  { a: "Book Toronto hotel conference", b: "Order laptop charger", label: 0 },
  { a: "Gym session trainer Tuesday", b: "Submit expense report", label: 0 },
  { a: "Kubernetes cluster upgrade", b: "Sourdough starter feeding", label: 0 },
  { a: "Postgres replication lag", b: "Q3 budget review meeting", label: 0 },
  { a: "Pick up dry cleaning", b: "Refinance mortgage", label: 0 },
  { a: "Mom birthday March flowers", b: "Server migration midnight", label: 0 },
  { a: "Flight AC1234 terminal 2", b: "Pay the electricity bill", label: 0 },
  { a: "Vet appointment Monday Biscuit", b: "Deploy checklist backup database", label: 0 },
  { a: "Wine tasting Friday downtown", b: "Call plumber kitchen sink", label: 0 },
  { a: "Kids soccer field 3", b: "Renew car insurance Friday", label: 0 },
  { a: "New tires truck winter", b: "Dentist checkup June kids", label: 0 },
  { a: "Camping Banff August", b: "Invoice Acme overdue", label: 0 },
  { a: "Recipe lemon garlic", b: "Basement wifi drops", label: 0 },
  { a: "Mower blade sharpen", b: "Garage opener battery", label: 0 },
  { a: "Flood basement rain", b: "Laptop flicker", label: 0 },

  // --- Shared-token traps, different topics (label 0) ---
  { a: "Call the dentist tomorrow", b: "Call the plumber tomorrow", label: 0 },
  { a: "Meeting at noon on Monday", b: "Lunch at noon on Monday", label: 0 },
  { a: "Buy milk", b: "Buy a new car", label: 0 },
  { a: "Water the plants", b: "Drink more water daily", label: 0 },
  { a: "Book a flight", b: "Book a hotel", label: 0 },
  { a: "Clean the garage", b: "Clean the gutters", label: 0 },
  { a: "Fix the sink", b: "Fix the fence", label: 0 },
  { a: "Paint the bedroom", b: "Paint the fence blue", label: 0 },
  { a: "Morning meeting notes", b: "Morning run routine", label: 0 },
  { a: "Team lunch Friday", b: "Date night Friday", label: 0 },
  { a: "New phone case", b: "New laptop charger", label: 0 },
  { a: "Doctor appointment Tuesday", b: "Dentist appointment Tuesday", label: 0 },
  { a: "Pay the rent", b: "Pay the internet bill", label: 0 },
  { a: "Pick up the kids", b: "Pick up the prescription", label: 0 },
  { a: "Check the oil", b: "Check the mail", label: 0 },
  { a: "Walk the dog", b: "Walk to the store", label: 0 },
  { a: "Cancel the subscription", b: "Cancel the appointment", label: 0 },
  { a: "Order pizza tonight", b: "Order office supplies", label: 0 },
  { a: "Charge the laptop", b: "Charge the drill batteries", label: 0 },
  { a: "Lock the back door", b: "Lock in the mortgage rate", label: 0 },

  // --- Shared boilerplate, different content (label 0) ---
  { a: "Quick note: buy milk", b: "Quick note: deploy api", label: 0 },
  { a: "Reminder: call mom", b: "Reminder: pay taxes", label: 0 },
  { a: "TODO: fix the bug", b: "TODO: write the docs", label: 0 },
  { a: "Idea: rooftop garden", b: "Idea: home gym", label: 0 },
  { a: "Follow up with the client", b: "Follow up with the landlord", label: 0 },
  { a: "Don't forget the keys", b: "Don't forget the charger", label: 0 },
  { a: "Meeting notes: standup", b: "Meeting notes: retro", label: 0 },
  { a: "Shopping list: apples", b: "Shopping list: socks", label: 0 },
  { a: "Project update: on track", b: "Project update: delayed", label: 0 },
  { a: "Status: all good", b: "Status: needs work", label: 0 },

  // --- More same-topic (label 1) ---
  { a: "Replace the air filter in the furnace", b: "Furnace air filter replacement due", label: 1 },
  { a: "Trim the hedges along the driveway", b: "Hedge trimming needed by the driveway", label: 1 },
  { a: "Defrost the chest freezer", b: "The chest freezer needs defrosting", label: 1 },
  { a: "Rotate the tires every six months", b: "Tire rotation is due, last done six months ago", label: 1 },
  { a: "Seal the deck before winter", b: "Deck sealing should happen before the cold", label: 1 },

  // --- More different topics (label 0) ---
  { a: "Replace air filter furnace", b: "Wine tasting downtown Friday", label: 0 },
  { a: "Trim hedges driveway", b: "Postgres replication lag", label: 0 },
  { a: "Defrost chest freezer", b: "Book Toronto hotel", label: 0 },
  { a: "Rotate tires six months", b: "Kids dentist June", label: 0 },
  { a: "Seal deck winter", b: "Garage door battery", label: 0 },

  // --- More shared-token traps (label 0) ---
  { a: "Replace the filter", b: "Replace the roof", label: 0 },
  { a: "Trim the budget", b: "Trim the hedges", label: 0 },
  { a: "Clean the windows", b: "Clean the oven", label: 0 },
  { a: "Start the mower", b: "Start the meeting", label: 0 },
  { a: "Empty the dishwasher", b: "Empty the trash", label: 0 },
];
