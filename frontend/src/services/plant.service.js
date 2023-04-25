import http from "../http-common";

class PlantDataService {
    getAll(data) {
        return http.get("/plants", data);
    }

    get(id) {
        return http.get(`/plants/${id}`);
    }

    create(data) {
        return http.post("/plants/add", data);
    }

    update(id, data) {
        return http.put(`/plants/${id}`, data);
    }

    delete(id) {
        return http.delete(`/plants/${id}`);
    }

    deleteAll() {
        return http.delete(`/plants`);
    }

    findByName(greenhouse, name) {
        return http.get(`/plants?greenhouse=${greenhouse}&name=${name}`);
    }

    findByGreenhouse(greenhouse) {
        return http.get(`/plants?greenhouse=${greenhouse}`);
    }
}

export default new PlantDataService();