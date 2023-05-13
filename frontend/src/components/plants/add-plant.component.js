import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import PlantDataService from "../../services/plant.service";
import { withAuth0 } from '@auth0/auth0-react';

function useInput(initialValue) {
    const [value, setValue] = useState(initialValue);
    const onChange = (e) => setValue(e.target.value);
    return { value, onChange };
}

function AddPlant({ auth0 }) {
    const navigate = useNavigate();
    const { user } = auth0;

    const name = useInput("");
    const type = useInput("");
    const location = useInput("");
    const description = useInput("");
    const waterFrequencyDays = useInput(0);
    const waterReminderTime = useInput("");

    const [submitted, setSubmitted] = useState(false);

    const savePlant = () => {
        const data = {
            userId: user.sub,
            greenhouse: user.greenhouse,
            name: name.value,
            type: type.value,
            location: location.value,
            description: description.value,
            water_frequency_days: waterFrequencyDays.value,
            water_reminder_time: waterReminderTime.value,        };

        PlantDataService.create(data)
            .then((response) => {
                console.log("creating plant in greenhouse: " + user.greenhouse);
                setSubmitted(true);
                navigate('/');
            })
            .catch((e) => {
                console.log(e);
            });
    };

    const newPlant = () => {
        name.onChange({ target: { value: "" } });
        type.onChange({ target: { value: "" } });
        location.onChange({ target: { value: "" } });
        description.onChange({ target: { value: "" } });
        waterFrequencyDays.onChange({ target: { value: 0 } });
        waterReminderTime.onChange({ target: { value: "" } });

        setSubmitted(false);
    };

    const daysOptions = Array.from({ length: 365 }, (_, i) => i + 1);
    const hoursOptions = Array.from({ length: 24 }, (_, i) => `${i.toString().padStart(2, "0")}:00`);

    return (
        <>
            <div>
                <h3>Add a Plant</h3>
            </div>
            <div className="submit-form">
                <div>
                    <div className="form-group">
                        <label htmlFor="Name">Name</label>
                        <input
                            type="text"
                            className="form-control"
                            id="name"
                            required
                            {...name}
                            name="Name"
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor="Type">Type</label>
                        <input
                            type="text"
                            className="form-control"
                            id="type"
                            required
                            {...type}
                            name="Type"
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor="Location">Location</label>
                        <input
                            type="text"
                            className="form-control"
                            id="type"
                            required
                            {...location}
                            name="Location"
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor="Description">Description</label>
                        <input
                            type="text"
                            className="form-control"
                            id="description"
                            required
                            {...description}
                            name="description"
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor={`days-watering`}>Remind me to water:</label>
                        <select id="days" {...waterFrequencyDays}>
                            <option value="">Select an option</option>
                            {daysOptions.map((option) => (
                                <option key={option} value={option}>
                                    Every {option} {option > 1 ? 'days' : 'day'}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="form-group">
                        <label htmlFor="water-reminder-time">Water Reminder Time:</label>
                        <select id="time" {...waterReminderTime}>
                            <option value="">Select an option (Pacific Time)</option>
                            {hoursOptions.map((option) => (
                                <option key={option} value={option}>
                                    {option}
                                </option>
                            ))}
                        </select>
                    </div>
                    <button onClick={savePlant} className="btn btn-success">
                        Submit
                    </button>
                </div>
            </div>
        </>
    );
}

export default withAuth0(AddPlant);
