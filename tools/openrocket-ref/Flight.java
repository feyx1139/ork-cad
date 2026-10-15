import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import com.google.inject.AbstractModule;
import com.google.inject.Guice;
import com.google.inject.Module;

import info.openrocket.core.database.ComponentPresetDao;
import info.openrocket.core.database.ComponentPresetDatabase;
import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.document.Simulation;
import info.openrocket.core.file.GeneralRocketLoader;
import info.openrocket.core.plugin.PluginModule;
import info.openrocket.core.rocketcomponent.FinSet;
import info.openrocket.core.rocketcomponent.MassComponent;
import info.openrocket.core.rocketcomponent.Rocket;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.simulation.FlightData;
import info.openrocket.core.simulation.FlightDataBranch;
import info.openrocket.core.simulation.FlightDataType;
import info.openrocket.core.simulation.listeners.SimulationListener;
import info.openrocket.core.startup.Application;
import info.openrocket.core.startup.CoreModule;

/**
 * Runs OpenRocket's own flight simulations of one design, headless, for scripts/flight.ts. It reads
 * commands from stdin, one per line, fields separated by tabs, and answers each with one line of
 * JSON on stdout:
 *
 *   info                         the design's simulations, mass components and fin sets
 *   run  sim=<n>  [mass=<component name>:<kg>]...  [cant=<fin set name>:<degrees>]...
 *                                runs simulation n (from 0, in the design's order) with those
 *                                masses and cant angles, and reports the flight
 *
 * Changes last only for that run. Each run uses the simulation's own random seed, so the same
 * command always gives the same flight (wind turbulence is random otherwise).
 *
 * Usage: java -cp OpenRocket-24.12.jar;build Flight <in.ork>
 */
public class Flight {
	public static void main(String[] args) throws Exception {
		if (args.length < 1) {
			System.err.println("usage: Flight <in.ork>");
			System.exit(2);
		}
		System.setProperty("openrocket.bypass.presets", "true");
		CoreModule core = new CoreModule();
		Module presetLookup = new AbstractModule() {
			@Override
			protected void configure() {
				bind(ComponentPresetDao.class).to(ComponentPresetDatabase.class);
			}
		};
		Application.setInjector(Guice.createInjector(core, presetLookup, new PluginModule()));
		core.startLoader();

		OpenRocketDocument doc = new GeneralRocketLoader(new File(args[0])).load();
		Rocket rocket = doc.getRocket();
		List<Simulation> sims = doc.getSimulations();
		int[] seeds = new int[sims.size()];
		for (int i = 0; i < sims.size(); i++) seeds[i] = sims.get(i).getOptions().getRandomSeed();

		BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
		String line;
		while ((line = in.readLine()) != null) {
			line = line.strip();
			if (line.isEmpty()) continue;
			String[] f = line.split("\t");
			try {
				if (f[0].equals("info")) {
					System.out.println(info(rocket, sims));
				} else if (f[0].equals("run")) {
					System.out.println(run(rocket, sims, seeds, f));
				} else {
					System.out.println("{\"error\": " + str("unknown command " + f[0]) + "}");
				}
			} catch (Exception e) {
				System.out.println("{\"error\": " + str(String.valueOf(e)) + "}");
			}
			System.out.flush();
		}
		System.exit(0);
	}

	private static String info(Rocket rocket, List<Simulation> sims) {
		StringBuilder s = new StringBuilder("{\"simulations\": [");
		for (int i = 0; i < sims.size(); i++) {
			Simulation sim = sims.get(i);
			if (i > 0) s.append(", ");
			s.append("{\"name\": ").append(str(sim.getName()));
			s.append(", \"motors\": ").append(str(sim.getActiveConfiguration().toString())).append("}");
		}
		s.append("], \"massComponents\": [");
		boolean first = true;
		for (RocketComponent c : rocket.getAllChildren()) {
			if (!(c instanceof MassComponent)) continue;
			if (!first) s.append(", ");
			first = false;
			s.append("{\"name\": ").append(str(c.getName())).append(", \"kg\": ").append(num(((MassComponent) c).getComponentMass())).append("}");
		}
		s.append("], \"finSets\": [");
		first = true;
		for (RocketComponent c : rocket.getAllChildren()) {
			if (!(c instanceof FinSet)) continue;
			FinSet fins = (FinSet) c;
			if (!first) s.append(", ");
			first = false;
			s.append("{\"name\": ").append(str(c.getName())).append(", \"cantDegrees\": ").append(num(Math.toDegrees(fins.getCantAngle())));
			s.append(", \"count\": ").append(fins.getFinCount()).append("}");
		}
		return s.append("]}").toString();
	}

	private static String run(Rocket rocket, List<Simulation> sims, int[] seeds, String[] f) throws Exception {
		int index = -1;
		List<Runnable> undo = new ArrayList<>();
		try {
			for (int k = 1; k < f.length; k++) {
				int eq = f[k].indexOf('=');
				String key = f[k].substring(0, eq);
				String value = f[k].substring(eq + 1);
				if (key.equals("sim")) {
					index = Integer.parseInt(value);
					continue;
				}
				int colon = value.lastIndexOf(':');
				String name = value.substring(0, colon);
				double v = Double.parseDouble(value.substring(colon + 1));
				boolean found = false;
				for (RocketComponent c : rocket.getAllChildren()) {
					if (!c.getName().equals(name)) continue;
					if (key.equals("mass") && c instanceof MassComponent) {
						MassComponent m = (MassComponent) c;
						double old = m.getComponentMass();
						m.setComponentMass(v);
						undo.add(() -> m.setComponentMass(old));
						found = true;
					} else if (key.equals("cant") && c instanceof FinSet) {
						FinSet fins = (FinSet) c;
						double old = fins.getCantAngle();
						fins.setCantAngle(Math.toRadians(v));
						undo.add(() -> fins.setCantAngle(old));
						found = true;
					}
				}
				if (!found) throw new IllegalArgumentException("no " + (key.equals("mass") ? "mass component" : "fin set") + " named " + name);
			}
			if (index < 0 || index >= sims.size()) throw new IllegalArgumentException("no simulation " + index);
			Simulation sim = sims.get(index);
			sim.getOptions().setRandomSeed(seeds[index]);
			sim.simulate(new SimulationListener[0]);
			FlightData data = sim.getSimulatedData();
			FlightDataBranch b = data.getBranch(0);
			List<Double> t = b.get(FlightDataType.TYPE_TIME);
			List<Double> roll = b.get(FlightDataType.TYPE_ROLL_RATE);
			List<Double> v = b.get(FlightDataType.TYPE_VELOCITY_TOTAL);
			List<Double> mass = b.get(FlightDataType.TYPE_MASS);
			List<Double> inertia = b.get(FlightDataType.TYPE_ROTATIONAL_INERTIA);
			double apogeeTime = data.getTimeToApogee();
			// Fastest spin up to apogee (after it, the parachute's twisting takes over), and the speed then.
			double maxRoll = 0, vAtRoll = 0, tAtRoll = 0;
			for (int i = 0; i < t.size() && t.get(i) <= apogeeTime; i++) {
				double r = Math.abs(roll.get(i));
				if (r > maxRoll) {
					maxRoll = r;
					vAtRoll = v.get(i);
					tAtRoll = t.get(i);
				}
			}
			StringBuilder s = new StringBuilder("{");
			s.append("\"apogee\": ").append(num(data.getMaxAltitude()));
			s.append(", \"maxVelocity\": ").append(num(data.getMaxVelocity()));
			s.append(", \"timeToApogee\": ").append(num(apogeeTime));
			s.append(", \"launchMass\": ").append(num(mass.get(0)));
			s.append(", \"rollInertia\": ").append(num(inertia.get(0)));
			s.append(", \"maxRollRate\": ").append(num(maxRoll));
			s.append(", \"maxRollTime\": ").append(num(tAtRoll));
			s.append(", \"velocityAtMaxRoll\": ").append(num(vAtRoll));
			s.append(", \"warnings\": ").append(str(data.getWarningSet().toString()));
			return s.append("}").toString();
		} finally {
			for (int k = undo.size() - 1; k >= 0; k--) undo.get(k).run();
		}
	}

	private static String num(double v) {
		if (Double.isNaN(v) || Double.isInfinite(v)) return "null";
		return String.format(Locale.ROOT, "%.10g", v);
	}

	private static String str(String v) {
		StringBuilder s = new StringBuilder("\"");
		for (char ch : v.toCharArray()) {
			switch (ch) {
				case '"' -> s.append("\\\"");
				case '\\' -> s.append("\\\\");
				case '\n' -> s.append("\\n");
				case '\r' -> s.append("\\r");
				case '\t' -> s.append("\\t");
				default -> {
					if (ch < 0x20) s.append(String.format("\\u%04x", (int) ch));
					else s.append(ch);
				}
			}
		}
		return s.append("\"").toString();
	}
}
